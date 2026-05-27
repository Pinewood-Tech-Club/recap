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
SELECTION_FRIEND_RATIO = 0.20   # friend slots = up to 20% of actual self count

GALLERY_SELF_CAP   = 300
GALLERY_CAP        = 400
MAX_FRIEND_RATIO   = 2
MAX_RANDOM         = 50

# ── In-memory store ───────────────────────────────────────────────────────────

_lock      = threading.Lock()
_galleries  = {}   # name -> gallery dict
_selections = {}   # name -> selection dict
_raw_metadata: dict = {}        # username -> {appearances: [{photo, score, bbox}]}
_photo_faces: dict = {}         # photo_path -> [username, ...]
_album_photos: dict = {}        # album_name -> [photo_path, ...]
_slug_albums: dict = {}         # category slug -> [album_name, ...]
_ready      = threading.Event()


def is_ready() -> bool:
    return _ready.is_set()


def wait_ready(timeout: float = 60.0) -> bool:
    return _ready.wait(timeout=timeout)


def get_selection(name: str) -> dict | None:
    return _selections.get(name)


def get_gallery(name: str) -> dict | None:
    return _galleries.get(name)


def get_raw_metadata() -> dict:
    return _raw_metadata


def get_photo_faces() -> dict:
    return _photo_faces


def get_album_photos() -> dict:
    return _album_photos


def get_slug_albums() -> dict:
    """Returns {slug: [album_name, ...]} built from categories.json."""
    return _slug_albums


def _flatten_categories(nodes: list, result: dict):
    """Recursively flatten category tree into {slug: [album_name, ...]}."""
    for node in nodes:
        slug = node.get("slug", "")
        albums = [a["album"] for a in node.get("albums", []) if "album" in a]
        if slug:
            result.setdefault(slug, []).extend(albums)
        _flatten_categories(node.get("subcategories", []), result)


# ── Core algorithm (ported from build_galleries.py) ───────────────────────────

def _confidence_weighted_sample(appearances: list, k: int) -> list:
    """Sample k photos weighted by confidence score (max 1.5x boost at top vs bottom)."""
    if k <= 0 or not appearances:
        return []
    if len(appearances) <= k:
        return [p for p, _ in appearances]
    scores = [s for _, s in appearances]
    lo, hi = min(scores), max(scores)
    rng = hi - lo if hi > lo else 1.0
    weighted = [(p, 1.0 + (s - lo) / rng * 0.5) for p, s in appearances]
    result, seen = [], set()
    pool = list(weighted)
    while len(result) < k and pool:
        paths, ws = zip(*pool)
        chosen = random.choices(paths, weights=ws, k=1)[0]
        result.append(chosen)
        seen.add(chosen)
        pool = [(p, w) for p, w in pool if p not in seen]
    return result


def _friend_weighted_sample(candidates: list, k: int) -> list:
    """Weighted-random sample of (photo, score) friend candidates by score."""
    if k <= 0 or not candidates:
        return []
    if len(candidates) <= k:
        return candidates
    result, seen = [], set()
    pool = list(candidates)
    while len(result) < k and pool:
        paths, ws = zip(*pool)
        chosen = random.choices(paths, weights=ws, k=1)[0]
        entry = next(e for e in pool if e[0] == chosen)
        result.append(entry)
        seen.add(chosen)
        pool = [e for e in pool if e[0] not in seen]
    return result


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
        own_appearances = [(a["photo"], a["score"]) for a in data["appearances"] if a["photo"] in all_photos_set]
        own_photos = [p for p, _ in own_appearances]
        own_set    = set(own_photos)
        f_scores   = friendliness[name]

        # Friend candidates: sum of friendliness scores for all people in photo
        # (rewards group shots where multiple friends appear)
        friend_candidates = []
        for photo, people in photo_to_people.items():
            if photo in own_set:
                continue
            scores = [f_scores.get(p, 0.0) for p in people]
            if max(scores, default=0.0) < FRIEND_THRESHOLD:
                continue
            friend_candidates.append((photo, round(sum(scores), 3)))
        friend_candidates.sort(key=lambda x: x[1], reverse=True)

        # ── selection ──
        # Self: confidence-weighted, up to SELECTION_COUNT
        sel_self_count = min(len(own_photos), SELECTION_COUNT)
        sel_self = _confidence_weighted_sample(own_appearances, sel_self_count)

        # Friend: up to 20% of actual self count, only if room left
        # Weighted-random sample by summed friendliness score (not a hard top-N cutoff)
        remaining_slots = SELECTION_COUNT - sel_self_count
        sel_friend_count = min(len(friend_candidates), round(sel_self_count * SELECTION_FRIEND_RATIO), remaining_slots)
        sel_friends = _friend_weighted_sample(friend_candidates, sel_friend_count)

        selection = (
            [{"path": p, "type": "self"} for p in sel_self]
            + [{"path": p, "type": "friend", "friend_score": s} for p, s in sel_friends]
        )
        random.shuffle(selection)
        selections[name] = {
            "name": name,
            "self_count": sel_self_count,
            "friend_count": sel_friend_count,
            "random_count": 0,
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
    global _galleries, _selections, _raw_metadata, _photo_faces, _album_photos, _slug_albums
    photos_base_url = photos_base_url.rstrip("/")
    try:
        logger.info("Galleries: fetching photos index...")
        resp = requests.get(f"{photos_base_url}/index/photos.json", timeout=30)
        resp.raise_for_status()
        photos_raw = resp.json()
        all_photos = [p["path"] for p in photos_raw]
        logger.info("Galleries: %d photos", len(all_photos))

        # Build photo-faces and album-photos indexes
        photo_faces_local: dict = {}
        album_photos_local: dict = defaultdict(list)
        for photo in photos_raw:
            path = photo["path"]
            photo_faces_local[path] = [f["name"] for f in photo.get("faces", [])]
            album = photo.get("album", "")
            if album:
                album_photos_local[album].append(path)

        logger.info("Galleries: fetching categories...")
        resp = requests.get(f"{photos_base_url}/index/categories.json", timeout=30)
        resp.raise_for_status()
        slug_albums_local: dict = {}
        _flatten_categories(resp.json().get("tree", []), slug_albums_local)
        logger.info("Galleries: %d category slugs", len(slug_albums_local))

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
            _galleries     = galleries
            _selections    = selections
            _raw_metadata  = all_metadata
            _photo_faces   = photo_faces_local
            _album_photos  = dict(album_photos_local)
            _slug_albums   = slug_albums_local
        _ready.set()
        logger.info("Galleries: ready (%d people)", len(galleries))

    except Exception as exc:
        logger.error("Galleries: build failed: %s", exc, exc_info=True)


def start(photos_base_url: str):
    """Kick off background build. Returns immediately."""
    t = threading.Thread(target=_load, args=(photos_base_url,), daemon=True, name="galleries-build")
    t.start()
