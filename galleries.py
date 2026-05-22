"""
Builds per-person gallery and selection data in memory from the photos CDN.
Called once at server startup in a background thread; results cached globally.

PHOTOS_BASE_URL should point to the deployed photos CDN
(e.g. https://photos.recap.pinewood.one).
"""

import json
import math
import random
import logging
import threading
from collections import defaultdict

import requests

logger = logging.getLogger(__name__)

METADATA_BUNDLES   = ["26", "27", "28", "29", "30", "31", "staff"]
FRIEND_THRESHOLD   = 0.4

SELECTION_COUNT        = 50
SELECTION_SELF_RATIO   = 0.70
SELECTION_FRIEND_RATIO = 0.25

GALLERY_SELF_CAP   = 300
GALLERY_CAP        = 400
MAX_FRIEND_RATIO   = 2
MAX_RANDOM         = 50

# ── In-memory store ───────────────────────────────────────────────────────────

_lock      = threading.Lock()
_galleries  = {}   # name -> gallery dict
_selections = {}   # name -> selection dict
_ready      = threading.Event()


def is_ready() -> bool:
    return _ready.is_set()


def get_selection(name: str) -> dict | None:
    return _selections.get(name)


def get_gallery(name: str) -> dict | None:
    return _galleries.get(name)


# ── Core algorithm (ported from build_galleries.py) ───────────────────────────

def _sqrt_weighted_sample(photos: list, k: int) -> list:
    if k <= 0:
        return []
    by_album: dict = defaultdict(list)
    for p in photos:
        parts = p.split("/")
        album = parts[1] if len(parts) > 2 else "__root__"
        by_album[album].append(p)
    albums  = list(by_album.keys())
    weights = [math.sqrt(len(by_album[a])) for a in albums]
    remaining = {a: list(by_album[a]) for a in albums}
    result, seen = [], set()
    attempts = 0
    while len(result) < k and attempts < k * 20:
        attempts += 1
        live = [a for a in albums if remaining[a]]
        if not live:
            break
        live_w = [weights[albums.index(a)] for a in live]
        album  = random.choices(live, weights=live_w, k=1)[0]
        photo  = random.choice(remaining[album])
        remaining[album].remove(photo)
        if photo not in seen:
            seen.add(photo)
            result.append(photo)
    return result


def _build_all(all_metadata: dict, all_photos: list) -> tuple[dict, dict]:
    all_photos_set = set(all_photos)

    # Inverted index: photo -> [names]
    photo_to_people: dict = defaultdict(list)
    for name, data in all_metadata.items():
        for ap in data["appearances"]:
            photo_to_people[ap["photo"]].append(name)

    # Co-occurrence counts
    co_count: dict = defaultdict(lambda: defaultdict(int))
    for people in photo_to_people.values():
        for i, p1 in enumerate(people):
            for p2 in people[i + 1:]:
                co_count[p1][p2] += 1
                co_count[p2][p1] += 1

    # Friendliness scores
    friendliness: dict = {}
    for name in all_metadata:
        counts = co_count[name]
        if not counts:
            friendliness[name] = {}
            continue
        max_co = max(counts.values())
        friendliness[name] = {f: c / max_co for f, c in counts.items()}

    galleries:  dict = {}
    selections: dict = {}

    for name, data in all_metadata.items():
        own_photos = [a["photo"] for a in data["appearances"]]
        own_set    = set(own_photos)
        f_scores   = friendliness[name]

        # Friend candidates scored by max friendliness
        friend_candidates = []
        for photo, people in photo_to_people.items():
            if photo in own_set:
                continue
            score = max((f_scores.get(p, 0.0) for p in people), default=0.0)
            if score >= FRIEND_THRESHOLD:
                friend_candidates.append((photo, round(score, 3)))
        friend_candidates.sort(key=lambda x: x[1], reverse=True)

        # ── selection ──
        sel_self_count   = min(len(own_photos), round(SELECTION_COUNT * SELECTION_SELF_RATIO))
        sel_friend_count = round(SELECTION_COUNT * SELECTION_FRIEND_RATIO)
        sel_random_count = SELECTION_COUNT - sel_self_count - sel_friend_count

        sel_self    = random.sample(own_photos, sel_self_count)
        sel_friends = friend_candidates[:sel_friend_count]
        sel_used    = set(sel_self) | {p for p, _ in sel_friends}
        sel_remaining = [p for p in all_photos if p not in sel_used and p not in own_set]
        sel_random  = _sqrt_weighted_sample(sel_remaining, min(sel_random_count, len(sel_remaining)))

        selection = (
            [{"path": p, "type": "self"} for p in sel_self]
            + [{"path": p, "type": "friend", "friend_score": s} for p, s in sel_friends]
            + [{"path": p, "type": "random"} for p in sel_random]
        )
        random.shuffle(selection)
        selections[name] = {
            "name": name,
            "self_count": sel_self_count,
            "friend_count": len(sel_friends),
            "random_count": len(sel_random),
            "total": len(selection),
            "photos": selection,
        }

        # ── gallery ──
        gallery_self = sel_self + [p for p in own_photos if p not in set(sel_self)]
        gallery_self = gallery_self[:GALLERY_SELF_CAP]
        gallery_self_set = set(gallery_self)

        slots_for_others = GALLERY_CAP - len(gallery_self)
        max_friends      = min(len(gallery_self) * MAX_FRIEND_RATIO, slots_for_others)
        gallery_friends  = friend_candidates[:max(0, int(max_friends))]

        gallery_used      = gallery_self_set | {p for p, _ in gallery_friends}
        gallery_remaining = [p for p in all_photos if p not in gallery_used]
        random_count      = min(MAX_RANDOM, GALLERY_CAP - len(gallery_self) - len(gallery_friends))
        gallery_random    = _sqrt_weighted_sample(gallery_remaining, min(max(0, random_count), len(gallery_remaining)))

        gallery_photos = (
            [{"path": p, "type": "self"} for p in gallery_self]
            + [{"path": p, "type": "friend", "friend_score": s} for p, s in gallery_friends]
            + [{"path": p, "type": "random"} for p in gallery_random]
        )
        tail = gallery_photos[len(gallery_self):]
        random.shuffle(tail)
        gallery_photos = gallery_photos[:len(gallery_self)] + tail

        galleries[name] = {
            "name": name,
            "own_count": len(gallery_self),
            "friend_count": len(gallery_friends),
            "random_count": len(gallery_random),
            "total": len(gallery_photos),
            "photos": gallery_photos,
        }

    return galleries, selections


# ── Startup loader ────────────────────────────────────────────────────────────

def _load(photos_base_url: str):
    global _galleries, _selections
    photos_base_url = photos_base_url.rstrip("/")
    try:
        logger.info("Galleries: fetching photos index...")
        resp = requests.get(f"{photos_base_url}/index/photos.json", timeout=30)
        resp.raise_for_status()
        all_photos = [p["path"] for p in resp.json()]
        logger.info("Galleries: %d photos", len(all_photos))

        logger.info("Galleries: fetching metadata bundles...")
        all_metadata: dict = {}
        for bundle_key in METADATA_BUNDLES:
            resp = requests.get(f"{photos_base_url}/metadata/{bundle_key}.json", timeout=30)
            resp.raise_for_status()
            all_metadata.update(resp.json())
        logger.info("Galleries: %d people loaded", len(all_metadata))

        logger.info("Galleries: building...")
        galleries, selections = _build_all(all_metadata, all_photos)

        with _lock:
            _galleries  = galleries
            _selections = selections
        _ready.set()
        logger.info("Galleries: ready (%d people)", len(galleries))

    except Exception as exc:
        logger.error("Galleries: build failed: %s", exc, exc_info=True)


def start(photos_base_url: str):
    """Kick off background build. Returns immediately."""
    t = threading.Thread(target=_load, args=(photos_base_url,), daemon=True, name="galleries-build")
    t.start()
