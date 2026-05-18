"""
Recap MVP server.

Flow:
- GET /            : Landing page with CTA to connect Schoology
- GET /auth/start  : Begin three-legged OAuth
- GET /auth/callback : Complete OAuth, queue recap job, redirect to /recap?id={uuid}
- GET /recap       : Frontend shell that polls /api/job/{id} for recap data
- GET /api/job/{id}: Job status + slides JSON
"""

import os
import uuid
import logging
import sys
import json
import sqlite3
import threading
import time
import queue
import base64
from datetime import datetime, timedelta
from collections import defaultdict
from types import SimpleNamespace
from flask import (
    Flask,
    render_template,
    redirect,
    request,
    url_for,
    jsonify,
    session,
)
from werkzeug.middleware.proxy_fix import ProxyFix
from flask_sock import Sock
from test_img import (
    render_busiest_month_card,
    render_general_stat_card,
    render_procrast_stat_card,
    render_recap_grid,
    render_top_classmates_card,
)

# Optional dotenv load for local dev
try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass

import schoolopy
import requests_oauthlib
import requests
from xml.sax.saxutils import escape as xml_escape
from concurrent.futures import ThreadPoolExecutor, as_completed

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger(__name__)

app = Flask(__name__)
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "dev-secret-key")
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)  # trust reverse proxy for scheme/host
sock = Sock(app)

# Config
SCHOOLOGY_CONSUMER_KEY = os.environ.get("SCHOOLOGY_CONSUMER_KEY")
print(SCHOOLOGY_CONSUMER_KEY)
SCHOOLOGY_CONSUMER_SECRET = os.environ.get("SCHOOLOGY_CONSUMER_SECRET")
SCHOOLOGY_DOMAIN = os.environ.get("SCHOOLOGY_DOMAIN", "https://app.schoology.com")
SCHOOLOGY_API_DOMAIN = os.environ.get("SCHOOLOGY_API_DOMAIN", "https://api.schoology.com")
JOB_DB_PATH = os.environ.get("JOB_DB_PATH", "/data/jobs.db")
TWO_LEGGED_DEBUG = os.environ.get("TWO_LEGGED_DEBUG", "").lower() == "true"
DEBUG_EMAIL = os.environ.get("DEBUG_EMAIL", "debug@example.com")
VERBOSE_PROGRESS = os.environ.get("VERBOSE_PROGRESS", "").lower() == "true"

# WebSocket subscriber registry: job_id -> list[queue.Queue]
subscribers: dict[str, list[queue.Queue]] = {}

if not SCHOOLOGY_CONSUMER_KEY or not SCHOOLOGY_CONSUMER_SECRET:
    logger.warning("Schoology consumer key/secret missing; OAuth will fail.")

with open(os.path.join(os.path.dirname(__file__), "pinewood_roles.json")) as f:
    _role_data = json.load(f)
FACULTY_ROLE_IDS = {r["id"] for r in _role_data["role"] if r["faculty"] == 1}

# Initialize databases ---------------------------------------------------
def init_recap_db():
    """Initialize both recaps (permanent) and jobs (temporary queue) tables."""
    conn = sqlite3.connect(JOB_DB_PATH)
    cur = conn.cursor()

    # Recaps table (permanent storage)
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS recaps (
            id TEXT PRIMARY KEY,
            email TEXT UNIQUE,
            slides_json TEXT,
            created_at TEXT,
            updated_at TEXT
        )
        """
    )

    # Jobs table (temporary queue - deleted after completion)
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY,
            email TEXT,
            status TEXT,
            access_token TEXT,
            access_token_secret TEXT,
            two_legged INTEGER DEFAULT 0,
            progress_json TEXT,
            created_at TEXT
        )
        """
    )

    conn.commit()
    conn.close()


init_recap_db()


# Database helper functions -------------------------------------------------
def get_conn():
    return sqlite3.connect(JOB_DB_PATH, check_same_thread=False)


# Recap operations (permanent storage)
def get_recap_by_email(email):
    """Get the recap for an email (one per email)."""
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("SELECT id, email, slides_json, created_at, updated_at FROM recaps WHERE email = ?", (email,))
    row = cur.fetchone()
    conn.close()
    if not row:
        return None
    return {
        "id": row[0],
        "email": row[1],
        "slides": json.loads(row[2]) if row[2] else None,
        "created_at": row[3],
        "updated_at": row[4],
    }


def get_recap_by_id(recap_id):
    """Get a recap by its ID."""
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("SELECT id, email, slides_json, created_at, updated_at FROM recaps WHERE id = ?", (recap_id,))
    row = cur.fetchone()
    conn.close()
    if not row:
        return None
    return {
        "id": row[0],
        "email": row[1],
        "slides": json.loads(row[2]) if row[2] else None,
        "created_at": row[3],
        "updated_at": row[4],
    }


def save_recap(recap_id, email, slides):
    """Save or update a recap (replaces existing for this email)."""
    conn = get_conn()
    cur = conn.cursor()
    now = datetime.utcnow().isoformat()
    # Delete existing recap for this email
    cur.execute("DELETE FROM recaps WHERE email = ?", (email,))
    # Insert new recap
    cur.execute(
        "INSERT INTO recaps (id, email, slides_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        (recap_id, email, json.dumps(slides), now, now),
    )
    conn.commit()
    conn.close()


def update_recap_slides(recap_id, slides):
    """Update slides_json for an existing recap."""
    conn = get_conn()
    cur = conn.cursor()
    now = datetime.utcnow().isoformat()
    cur.execute(
        "UPDATE recaps SET slides_json = ?, updated_at = ? WHERE id = ?",
        (json.dumps(slides), now, recap_id),
    )
    conn.commit()
    conn.close()


# Job operations (temporary queue)
def create_job(job_id, email, access_token, access_token_secret, two_legged=False):
    """Create a new job in the queue."""
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        """
        INSERT INTO jobs (id, email, status, access_token, access_token_secret, two_legged, created_at, progress_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (job_id, email, "queued", access_token, access_token_secret, 1 if two_legged else 0, datetime.utcnow().isoformat(), None),
    )
    conn.commit()
    conn.close()


def get_job(job_id):
    """Get a job from the queue."""
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        "SELECT id, email, status, access_token, access_token_secret, two_legged, progress_json FROM jobs WHERE id = ?",
        (job_id,),
    )
    row = cur.fetchone()
    conn.close()
    if not row:
        return None
    return {
        "id": row[0],
        "email": row[1],
        "status": row[2],
        "access_token": row[3],
        "access_token_secret": row[4],
        "two_legged": bool(row[5]),
        "progress": json.loads(row[6]) if row[6] else None,
    }


def get_job_by_email(email):
    """Get the active job for an email (if any)."""
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        "SELECT id, email, status, progress_json FROM jobs WHERE email = ? LIMIT 1",
        (email,),
    )
    row = cur.fetchone()
    conn.close()
    if not row:
        return None
    return {
        "id": row[0],
        "email": row[1],
        "status": row[2],
        "progress": json.loads(row[3]) if row[3] else None,
    }


def update_job_progress(job_id, progress):
    """Update job progress."""
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        "UPDATE jobs SET progress_json = ? WHERE id = ?",
        (json.dumps(progress), job_id),
    )
    conn.commit()
    conn.close()


def delete_job(job_id):
    """Delete a job from the queue (after completion or error)."""
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("DELETE FROM jobs WHERE id = ?", (job_id,))
    conn.commit()
    conn.close()


def claim_next_job():
    """Atomically claim the next queued job."""
    conn = get_conn()
    conn.isolation_level = "EXCLUSIVE"
    cur = conn.cursor()
    cur.execute(
        "SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1"
    )
    row = cur.fetchone()
    if not row:
        conn.close()
        return None
    job_id = row[0]
    cur.execute(
        "UPDATE jobs SET status = 'running' WHERE id = ? AND status = 'queued'",
        (job_id,),
    )
    if cur.rowcount == 1:
        cur.execute(
            "SELECT id, email, access_token, access_token_secret, two_legged FROM jobs WHERE id = ?",
            (job_id,),
        )
        job_row = cur.fetchone()
        conn.commit()
        conn.close()
        return {
            "id": job_row[0],
            "email": job_row[1],
            "access_token": job_row[2],
            "access_token_secret": job_row[3],
            "two_legged": bool(job_row[4]),
        }
    conn.commit()
    conn.close()
    return None


def notify_progress(job_id: str, payload: dict):
    """Notify WebSocket subscribers and persist progress."""
    # Push to subscribers
    subs = subscribers.get(job_id, [])
    for q in subs:
        q.put(payload)
    # Update job progress (not status, since status is only queued/running)
    if payload.get("status") not in ["done", "error"]:
        update_job_progress(job_id, payload)


def get_base_url():
    """Return the externally reachable base URL."""
    base_url = os.environ.get("PUBLIC_BASE_URL", "").rstrip("/")
    if not base_url:
        base_url = request.host_url.rstrip("/")
    return base_url


def get_share_image_url(recap_id: str):
    base_url = get_base_url()
    return f"{base_url}/static/userdata/{recap_id}/grid.png"


def fetch_user_profile(auth, user_id: str | None):
    if not user_id:
        return {}
    try:
        resp = auth.oauth.get(f"{SCHOOLOGY_API_DOMAIN}/v1/users/{user_id}", timeout=10)
        if resp.status_code == 200:
            return resp.json() or {}
    except Exception as exc:  # pylint: disable=broad-except
        logger.warning("Failed to fetch user profile for %s: %s", user_id, exc)
    return {}


def fetch_avatar_data_uri(auth, avatar_url: str | None):
    if not avatar_url:
        return None

    session = getattr(auth, "oauth", None)
    try:
        resp = session.get(avatar_url, timeout=10) if session else requests.get(avatar_url, timeout=10)
    except Exception as exc:  # pylint: disable=broad-except
        logger.warning("Avatar fetch failed for %s: %s", avatar_url, exc)
        return None

    if not resp or resp.status_code >= 400:
        logger.warning("Avatar fetch returned status %s for %s", getattr(resp, "status_code", "?"), avatar_url)
        return None

    data = resp.content or b""
    content_type = resp.headers.get("content-type", "").split(";")[0].strip().lower()
    is_svg = "svg" in content_type or avatar_url.lower().endswith(".svg")
    media_type = content_type or "image/png"

    if is_svg:
        try:
            import cairosvg

            data = cairosvg.svg2png(bytestring=data)
            media_type = "image/png"
        except Exception as exc:  # pylint: disable=broad-except
            logger.warning("SVG to PNG conversion failed for %s: %s", avatar_url, exc)
            media_type = "image/svg+xml"

    try:
        encoded = base64.b64encode(data).decode("ascii")
        return f"data:{media_type};base64,{encoded}"
    except Exception as exc:  # pylint: disable=broad-except
        logger.warning("Avatar encoding failed for %s: %s", avatar_url, exc)
        return None


def send_recap_email(email: str | None, job_id: str):
    """Send recap-ready email via SES when configured, else log to console."""
    if not email:
        return

    base_url = os.environ.get("PUBLIC_BASE_URL", "").rstrip("/")
    recap_link = f"{base_url}/recap/{job_id}" if base_url else f"/recap/{job_id}"

    ses_region = os.environ.get("AWS_SES_REGION")
    ses_sender = os.environ.get("AWS_SES_SENDER")
    aws_key = os.environ.get("AWS_ACCESS_KEY_ID")
    aws_secret = os.environ.get("AWS_SECRET_ACCESS_KEY")

    if ses_region and ses_sender and aws_key and aws_secret:
        try:
            import boto3

            ses_client = boto3.client(
                "ses",
                region_name=ses_region,
                aws_access_key_id=aws_key,
                aws_secret_access_key=aws_secret,
            )
            ses_client.send_email(
                Source=ses_sender,
                Destination={"ToAddresses": [email]},
                Message={
                    "Subject": {"Data": "Your Schoology recap is ready"},
                    "Body": {
                        "Text": {
                            "Data": f"Your recap is ready. View it here: {recap_link}",
                        }
                    },
                },
            )
            logger.info("SES email sent to %s for recap %s", email, job_id)
            return
        except Exception as exc:  # pylint: disable=broad-except
            logger.exception("SES email failed; falling back to log: %s", exc)

    # Fallback: log/print if SES not configured
    logger.info("Recap ready for %s; link: %s", email, recap_link)


# Background worker ----------------------------------------------------------
def worker():
    while True:
        job = claim_next_job()
        if not job:
            time.sleep(2)
            continue
        job_id = job["id"]
        logger.info("Processing job %s", job_id)
        try:
            notify_progress(job_id, {"status": "running", "message": "Starting job"})
            slides = build_recap(
                {
                    "job_id": job_id,
                    "access_token": job["access_token"],
                    "access_token_secret": job["access_token_secret"],
                    "email": job["email"],
                    "two_legged": job.get("two_legged", False),
                }
            )
            # Save to recaps table
            save_recap(job_id, job["email"], slides)
            # Notify completion
            notify_progress(job_id, {"status": "done", "slides": slides})
            # Delete job from queue (OAuth tokens deleted)
            delete_job(job_id)
            send_recap_email(job["email"], job_id)
        except Exception as exc:  # pylint: disable=broad-except
            logger.exception("Job %s failed", job_id)
            # Notify error
            notify_progress(job_id, {"status": "error", "error": str(exc)})
            # Delete job from queue (don't leave failed jobs)
            delete_job(job_id)


worker_thread = threading.Thread(target=worker, daemon=True)
worker_thread.start()


# Helpers -------------------------------------------------------------------
def create_schoology_client(access_token: str | None, access_token_secret: str | None, two_legged: bool = False):
    """Create a Schoology client. Supports two-legged debug mode when flagged."""
    auth = schoolopy.Auth(
        SCHOOLOGY_CONSUMER_KEY,
        SCHOOLOGY_CONSUMER_SECRET,
        three_legged=not two_legged,
        domain=SCHOOLOGY_DOMAIN,
        access_token=access_token,
        access_token_secret=access_token_secret,
    )
    if two_legged:
        auth.oauth = requests_oauthlib.OAuth1Session(
            SCHOOLOGY_CONSUMER_KEY,
            client_secret=SCHOOLOGY_CONSUMER_SECRET,
        )
    else:
        # schoolopy Auth __init__ sets oauth with only consumer creds; rebuild with access tokens
        auth.oauth = requests_oauthlib.OAuth1Session(
            SCHOOLOGY_CONSUMER_KEY,
            client_secret=SCHOOLOGY_CONSUMER_SECRET,
            resource_owner_key=access_token,
            resource_owner_secret=access_token_secret,
        )
    sc = schoolopy.Schoology(auth)
    sc.limit = 200  # reduce pagination pressure where honored
    return sc, auth


def get_latest_user_submission(sc, auth, section_id: str, assignment_id: str, user_id: str):
    """
    Fetch latest submission for a user on an assignment.
    Uses submissions/revisions endpoint with all_revisions.
    """
    if not user_id:
        return None
    subs = []

    # Primary endpoint: list revisions for assignment, filter by uid
    try:
        url = f"{SCHOOLOGY_API_DOMAIN}/v1/sections/{section_id}/submissions/{assignment_id}/?all_revisions=true&with_attachments=true"
        resp = auth.oauth.get(url)
        if resp.status_code == 200:
            data = resp.json() or {}
            revs = data.get("revision") or []
            subs = [to_obj(r) for r in revs if str(r.get("uid", "")) == str(user_id)]
    except Exception:
        subs = []

    # Fallback: user-specific revision endpoint
    if not subs:
        try:
            url = f"{SCHOOLOGY_API_DOMAIN}/v1/sections/{section_id}/submissions/{assignment_id}/{user_id}?all_revisions=true&with_attachments=true"
            resp = auth.oauth.get(url)
            if resp.status_code == 200:
                data = resp.json() or {}
                revs = data.get("revision") or data.get("submission") or []
                if isinstance(revs, dict) and "revision" in revs:
                    revs = revs["revision"]
                subs = [to_obj(r) for r in revs] if isinstance(revs, list) else []
        except Exception:
            subs = []

    def sub_timestamp(sub_obj):
        ts = parse_dt(getattr(sub_obj, "submitted", None)) or parse_dt(getattr(sub_obj, "created", None))
        return ts or datetime.min

    latest = None
    if subs:
        latest = max(subs, key=sub_timestamp)
    return latest


def parse_dt(value):
    """Parse Schoology datetime (string or epoch) to naive datetime; return None on failure."""
    if not value:
        return None
    # epoch int/str
    if isinstance(value, (int, float)):
        try:
            return datetime.utcfromtimestamp(float(value))
        except Exception:
            pass
    if isinstance(value, str) and value.isdigit():
        try:
            return datetime.utcfromtimestamp(float(value))
        except Exception:
            pass
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(value, fmt)
        except Exception:
            continue
    return None


def to_obj(item: dict):
    """Lightweight object wrapper for dicts."""
    return SimpleNamespace(**item)


def paginated_list(auth, path: str, key: str | None = None):
    """
    Fetch all pages for a Schoology collection endpoint.
    Returns list of dicts.
    """
    items = []
    url = f"{SCHOOLOGY_API_DOMAIN}/v1/{path}"
    while url:
        resp = auth.oauth.get(url)
        resp.raise_for_status()
        data = resp.json() or {}
        target_key = key
        if not target_key:
            # best-effort: pick the first list-valued key that's not links
            for k, v in data.items():
                if isinstance(v, list):
                    target_key = k
                    break
        if target_key and isinstance(data.get(target_key), list):
            items.extend(data.get(target_key, []))
        links = data.get("links", {}) or {}
        url = links.get("next")
    return items


def _to_float(val, default=0.0):
    try:
        return float(val)
    except Exception:
        return default


def _chunked(lst, n):
    lst = list(lst)
    for i in range(0, len(lst), n):
        yield lst[i:i + n]


def _schoology_multiget(auth, paths):
    """POST /v1/multiget; returns one payload dict per path (empty dict on per-item error)."""
    body_lines = ['<?xml version="1.0" encoding="utf-8" ?>', '<requests>']
    for path in paths:
        body_lines.append(f'  <request>{xml_escape(path)}</request>')
    body_lines.append('</requests>')
    resp = auth.oauth.post(
        f"{SCHOOLOGY_API_DOMAIN}/v1/multiget",
        data='\n'.join(body_lines).encode('utf-8'),
        headers={'Accept': 'application/json', 'Content-Type': 'text/xml; charset=utf-8'},
        timeout=60,
    )
    resp.raise_for_status()
    raw = resp.json()

    # Unwrap envelope — handle list-directly, nested dicts, multiple key names
    if isinstance(raw, list):
        items = raw
    elif isinstance(raw, dict):
        items = next(
            (raw[k] for k in ('responses', 'response', 'results', 'items') if isinstance(raw.get(k), list)),
            None,
        )
        if items is None and 'responses' in raw and isinstance(raw['responses'], dict):
            inner = raw['responses']
            items = next(
                (inner[k] for k in ('response', 'results', 'items') if isinstance(inner.get(k), list)),
                None,
            )
        if items is None:
            raise ValueError(f"Unexpected multiget envelope keys: {list(raw.keys())}")
    else:
        raise ValueError("multiget did not return JSON")

    if len(items) != len(paths):
        raise ValueError(f"multiget: sent {len(paths)} paths, got {len(items)} responses")

    results = []
    for item in items:
        if not isinstance(item, dict):
            results.append({})
            continue
        try:
            code = int(
                item.get('code') or item.get('status') or
                item.get('status_code') or item.get('response_code') or 0
            )
            if code >= 400:
                results.append({})
                continue
        except (TypeError, ValueError):
            pass
        # Unwrap body/data/result/response/payload — also handle JSON strings
        payload = item
        for key in ('body', 'data', 'result', 'response', 'payload'):
            if key not in item:
                continue
            cand = item[key]
            if isinstance(cand, dict):
                payload = cand
                break
            if isinstance(cand, str) and cand.strip():
                try:
                    payload = json.loads(cand)
                    break
                except ValueError:
                    pass
        results.append(payload if isinstance(payload, dict) else {})
    return results


def _fetch_for_sections(auth, section_ids, sub_path, item_key, page_limit=200):
    """
    Batch-fetch a sub-resource for many sections via parallel multigets.
    Returns {section_id_str: [item_dict, ...]} for all sections.
    Falls back to serial paginated_list per section on chunk failure.
    """
    results = {str(sid): [] for sid in section_ids}
    sid_list = list(section_ids)
    paths = [f"/v1/sections/{sid}/{sub_path}?limit={page_limit}" for sid in sid_list]

    chunks = list(zip(_chunked(paths, 50), _chunked(sid_list, 50)))

    def _do_chunk(chunk_paths, chunk_sids):
        return _schoology_multiget(auth, chunk_paths), list(chunk_sids)

    with ThreadPoolExecutor(max_workers=10) as executor:
        future_to_sids = {
            executor.submit(_do_chunk, list(cp), list(cs)): (list(cp), list(cs))
            for cp, cs in chunks
        }
        for future in as_completed(future_to_sids):
            chunk_paths, chunk_sids = future_to_sids[future]
            try:
                payloads, chunk_sids = future.result()
            except Exception as exc:
                logger.warning("multiget chunk failed for %s (%s), falling back to serial", sub_path, exc)
                for sid in chunk_sids:
                    try:
                        results[str(sid)] = paginated_list(auth, f"sections/{sid}/{sub_path}", key=item_key)
                    except Exception:
                        pass
                continue

            for sid, payload in zip(chunk_sids, payloads):
                if not payload:
                    continue
                items = payload.get(item_key, [])
                if isinstance(items, dict):
                    items = [items]
                results[str(sid)] = list(items) if items else []

                # Handle overflow pages serially (rare; only when server truncates at page_limit)
                links = payload.get("links", {}) or {}
                next_url = links.get("next")
                while next_url:
                    try:
                        r = auth.oauth.get(next_url, timeout=30)
                        r.raise_for_status()
                        d = r.json() or {}
                        more = d.get(item_key, [])
                        if isinstance(more, dict):
                            more = [more]
                        results[str(sid)].extend(more)
                        next_url = (d.get("links", {}) or {}).get("next")
                    except Exception:
                        break

    return results


def _fetch_user_submissions(auth, tasks, user_id):
    """
    Fetch per-user submission revisions for a list of (section_id, assignment_id) pairs.
    Returns {(section_id, assignment_id): SimpleNamespace | None}.

    Schoology's multiget API does not support the submissions endpoint, so we fire
    individual GETs in parallel via ThreadPoolExecutor instead.
    """
    if not user_id:
        return {}

    def _sub_ts(s):
        ts = parse_dt(getattr(s, "submitted", None)) or parse_dt(getattr(s, "created", None))
        return ts or datetime.min

    empty_revs = 0
    wrong_uid  = 0
    matched    = 0

    def _fetch_one(sid, aid):
        url = f"{SCHOOLOGY_API_DOMAIN}/v1/sections/{sid}/submissions/{aid}?all_revisions=true"
        for attempt in range(5):
            try:
                resp = auth.oauth.get(url, timeout=15)
                if resp.status_code == 429:
                    wait = int(resp.headers.get("Retry-After", 2))
                    time.sleep(wait)
                    continue
                return (sid, aid), resp.status_code, resp.json() if resp.status_code == 200 else {}
            except Exception as exc:
                logger.warning("submission GET error (%s, %s): %s", sid, aid, exc)
                return (sid, aid), 0, {}
        logger.warning("submission %s/%s still 429 after 5 attempts", sid, aid)
        return (sid, aid), 429, {}

    output = {}
    # max_workers=3 keeps us under Schoology's 15-req/5s rate limit
    with ThreadPoolExecutor(max_workers=3) as executor:
        futures = {executor.submit(_fetch_one, sid, aid): (sid, aid) for sid, aid in tasks}
        for future in as_completed(futures):
            (sid, aid), status, data = future.result()

            if status != 200:
                output[(sid, aid)] = None
                continue

            revs = data.get("revision") or data.get("submission") or []
            if isinstance(revs, dict) and "revision" in revs:
                revs = revs["revision"]
            if not isinstance(revs, list):
                revs = []

            if not revs:
                empty_revs += 1
                output[(sid, aid)] = None
                continue

            user_revs = [to_obj(r) for r in revs if str(r.get("uid", "")) == str(user_id)]
            if not user_revs:
                wrong_uid += 1
                if wrong_uid == 1:
                    sample_uids = list({str(r.get("uid", "?")) for r in revs[:5]})
                    logger.info("uid mismatch: want %s got %s (aid=%s)", user_id, sample_uids, aid)
                output[(sid, aid)] = None
                continue

            matched += 1
            latest = max(user_revs, key=_sub_ts)
            latest._section_id = sid
            latest._assignment_id = aid
            output[(sid, aid)] = latest

    logger.info("submissions: %d tasks → matched=%d empty=%d uid_mismatch=%d errors=%d",
                len(tasks), matched, empty_revs, wrong_uid,
                sum(1 for v in output.values() if v is None) - empty_revs - wrong_uid)
    return output


def generate_share_images(slides: dict, recap_id: str):
    """Generate shareable recap grid image and stash path in slides."""
    static_root = app.static_folder or os.path.join(app.root_path, "static")
    out_dir = os.path.join(static_root, "userdata", recap_id)
    os.makedirs(out_dir, exist_ok=True)

    try:
        data = {
            "total_assignments": slides.get("total_assignments", 0),
            "course_count": slides.get("total_courses", slides.get("course_count", 0)),
            "late_night_submissions": slides.get("night_owl_subs", 0),
            "busiest_month": slides.get("busiest_month", ""),
            "busiest_month_assignments": slides.get("assignments_bm", 0),
            "weekend_submissions": slides.get("weekend_subs", 0),
            "avg_hours_before_deadline": _to_float(slides.get("avg_procrastination", 0.0)),
            "top_classmates": [
                {
                    "name": c.get("name", ""),
                    "detail": f"{c.get('count', 0)} shared classes",
                    "sections": c.get("sections", []),
                }
                for c in (slides.get("top_classmates") or [])[:3]
            ],
        }

        grid_path = os.path.join(out_dir, "grid.png")
        static_title_path = os.path.join(static_root, "Slide_center-title.png")
        static_cta_path = os.path.join(static_root, "Slide_CTA.png")
        render_recap_grid(
            grid_path,
            data,
            static_title_path=static_title_path,
            static_cta_path=static_cta_path,
        )

        # Per-slide images mapped to slide indices (0 = title, so start at 1)
        slide_images = {}
        try:
            slide_images[1] = f"/static/userdata/{recap_id}/slide-1.png"
            render_general_stat_card(
                os.path.join(out_dir, "slide-1.png"),
                data["total_assignments"],
                "I had",
                "assignments in Schoology",
                small_text=f"across {data.get('course_count', 0)} courses",
                background=(15, 23, 42),
                foreground=(226, 232, 240),
                accent=(34, 211, 238),
                size=1080,
            )

            slide_images[2] = f"/static/userdata/{recap_id}/slide-2.png"
            render_busiest_month_card(
                os.path.join(out_dir, "slide-2.png"),
                data.get("busiest_month", "October"),
                detail_text=f"With {data.get('busiest_month_assignments', 0)} assignments",
                size=1080,
            )

            slide_images[3] = f"/static/userdata/{recap_id}/slide-3.png"
            render_general_stat_card(
                os.path.join(out_dir, "slide-3.png"),
                data.get("weekend_submissions", 0),
                "I submitted",
                "assignments to Schoology",
                small_text="on weekends",
                background=(10, 22, 37),
                foreground=(226, 232, 240),
                accent=(34, 211, 238),
                size=1080,
            )

            slide_images[4] = f"/static/userdata/{recap_id}/slide-4.png"
            render_general_stat_card(
                os.path.join(out_dir, "slide-4.png"),
                data.get("weekday_submissions", data.get("weekday_subs", 0)),
                "I submitted",
                "assignments to Schoology",
                small_text="on weekdays",
                background=(12, 23, 40),
                foreground=(226, 232, 240),
                accent=(34, 211, 238),
                size=1080,
            )

            slide_images[5] = f"/static/userdata/{recap_id}/slide-5.png"
            render_procrast_stat_card(
                os.path.join(out_dir, "slide-5.png"),
                data.get("avg_hours_before_deadline", data.get("avg_procrastination", 0.0)),
                background=(237, 110, 102),
                foreground=(255, 255, 255),
                accent=(253, 224, 71),
                size=1080,
            )

            slide_images[6] = f"/static/userdata/{recap_id}/slide-6.png"
            render_general_stat_card(
                os.path.join(out_dir, "slide-6.png"),
                data.get("late_night_submissions", data.get("night_owl_subs", 0)),
                "I submitted",
                "assignments to Schoology",
                small_text="past 10pm",
                background=(12, 23, 40),
                foreground=(226, 232, 240),
                accent=(34, 211, 238),
                size=1080,
            )

            slide_images[7] = f"/static/userdata/{recap_id}/slide-7.png"
            render_top_classmates_card(
                os.path.join(out_dir, "slide-7.png"),
                data.get("top_classmates", []),
                background=(20, 21, 35),
                foreground=(230, 234, 240),
                accent=(14, 165, 233),
                size=1080,
            )
        except Exception as exc:  # pylint: disable=broad-except
            logger.warning("Failed to render per-slide images for %s: %s", recap_id, exc)

        slides["share_images"] = {
            "grid": f"/static/userdata/{recap_id}/grid.png",
            "slides": slide_images,
        }
    except Exception as exc:  # pylint: disable=broad-except
        logger.exception("Failed to generate share image for recap %s: %s", recap_id, exc)

    return slides


def _build_teacher_assignments(auth, sections, section_ids, job_id):
    """Build per-course grading event lists for teachers, plus top 3 slowest-returned assignments."""
    # Fetch assignment names + due dates for all sections
    raw_assignments = _fetch_for_sections(auth, section_ids, "assignments", "assignment")
    # assignment_id -> {title, due (epoch), course}
    assignment_meta = {}
    for section in sections:
        course_title = getattr(section, "course_title", "Unknown Course")
        for a in raw_assignments.get(str(section.id), []):
            aid = str(a.get("id", ""))
            if not aid:
                continue
            due_raw = a.get("due", None)
            due_ts = None
            if due_raw:
                parsed = parse_dt(due_raw)
                if parsed:
                    due_ts = int(parsed.timestamp())
            assignment_meta[aid] = {"title": a.get("title", "Unknown Assignment"), "due": due_ts, "course": course_title}

    course_list = []
    # assignment_id -> max grade timestamp (for slowest-return calc)
    assignment_last_graded = {}

    for section in sections:
        course_title = getattr(section, "course_title", "Unknown Course")
        notify_progress(job_id, {"status": "running", "stage": "grades", "course": course_title})
        events = []
        try:
            url = f"{SCHOOLOGY_API_DOMAIN}/v1/sections/{section.id}/grades"
            resp = auth.oauth.get(url, timeout=30)
            if resp.status_code == 200:
                data = resp.json() or {}
                grades = data.get("grades", {})
                if isinstance(grades, dict):
                    grades = grades.get("grade", [])
                if isinstance(grades, dict):
                    grades = [grades]
                for g in grades or []:
                    if g.get("grade") is None:
                        continue
                    exception = g.get("exception")
                    try:
                        if exception is not None and int(exception) in (2, 3):
                            continue
                    except (TypeError, ValueError):
                        pass
                    try:
                        ts = int(g.get("timestamp", 0))
                    except (TypeError, ValueError):
                        continue
                    if ts <= 0:
                        continue
                    events.append({"t": ts})
                    aid = str(g.get("assignment_id", ""))
                    if aid:
                        prev = assignment_last_graded.get(aid, 0)
                        if ts > prev:
                            assignment_last_graded[aid] = ts
        except Exception as exc:  # pylint: disable=broad-except
            logger.warning("grades fetch failed for section %s: %s", section.id, exc)
        course_list.append({"course": course_title, "data": events})

    # Compute top 3 slowest-returned assignments (last grade timestamp vs due date)
    slow_entries = []
    for aid, last_ts in assignment_last_graded.items():
        meta = assignment_meta.get(aid)
        if not meta or not meta.get("due"):
            continue
        days = (last_ts - meta["due"]) / 86400
        if days > 0:
            slow_entries.append({"assignment": meta["title"], "course": meta["course"], "days": round(days)})
    slow_entries.sort(key=lambda x: x["days"], reverse=True)
    top_slow_graded = slow_entries[:3]

    return course_list, top_slow_graded


def _build_student_assignments(auth, sections, assignments_by_section, latest_submissions, job_id):
    """Build per-course submission event lists for students."""
    course_list = []
    for section in sections:
        course_title = getattr(section, "course_title", "Unknown Course")
        events = []
        for a in assignments_by_section.get(section.id, []):
            sub = latest_submissions.get(str(a.id))
            if not sub:
                continue
            raw = getattr(sub, "submitted", None) or getattr(sub, "created", None)
            ts = None
            if isinstance(raw, (int, float)):
                ts = int(raw)
            elif isinstance(raw, str) and raw.isdigit():
                ts = int(raw)
            else:
                parsed = parse_dt(raw)
                if parsed:
                    ts = int(parsed.replace(tzinfo=None).timestamp())
            if ts is None or ts <= 0:
                continue
            events.append({"t": ts})
        course_list.append({"course": course_title, "data": events})
    return course_list


def build_recap(payload):
    """
    Fetch Schoology data and compute recap slides.
    This is intentionally light-weight and defensive for MVP.
    """
    job_id = payload["job_id"]
    access_token = payload["access_token"]
    access_token_secret = payload["access_token_secret"]
    user_email = payload.get("email")
    sc, auth = create_schoology_client(access_token, access_token_secret, two_legged=payload.get("two_legged", False))

    # Determine user_id robustly; allow debug override
    me = None
    try:
        me = sc.get_me()
    except Exception as _exc:
        logger.warning("get_me() failed: %s", _exc)
    user_id = getattr(me, "uid", None) if me else None
    profile_data = fetch_user_profile(auth, user_id)
    avatar_source_url = (
        profile_data.get("picture_url")
        or profile_data.get("picture")
        or profile_data.get("pic_url")
        or (getattr(me, "picture_url", "") if me else "")
    )
    avatar_data_uri = fetch_avatar_data_uri(auth, avatar_source_url)

    schoology_user = {
        "id": user_id,
        "name": profile_data.get("name_display")
        or profile_data.get("name")
        or (getattr(me, "name_display", "") if me else ""),
        "email": user_email or profile_data.get("primary_email") or (getattr(me, "primary_email", "") if me else ""),
        "avatar": avatar_data_uri or avatar_source_url or "",
    }
    notify_progress(job_id, {"status": "running", "stage": "me", "user_id": user_id})

    is_teacher = (getattr(me, "role_id", None) in FACULTY_ROLE_IDS) if me else False

    # Data buckets
    sections_raw = []
    if user_id:
        try:
            sections_raw = paginated_list(auth, f"users/{user_id}/sections", key="section")
        except Exception:
            sections_raw = []
    sections = [to_obj(s) for s in sections_raw]
    if not sections:
        try:
            sections = sc.get_sections() or []
        except Exception:
            sections = []

    notify_progress(job_id, {"status": "running", "stage": "sections", "count": len(sections)})

    section_ids = [s.id for s in sections]
    section_lookup = {s.id: s for s in sections}

    if is_teacher:
        course_list, top_slow_graded = _build_teacher_assignments(auth, sections, section_ids, job_id)
        return {
            "mode": "teacher",
            "user_name": schoology_user["name"],
            "assignments": course_list,
            "top_slow_graded": top_slow_graded,
        }

    # Batch-fetch enrollments for all sections
    notify_progress(job_id, {"status": "running", "stage": "enrollments"})
    raw_enrollments = _fetch_for_sections(auth, section_ids, "enrollments", "enrollment")
    section_enrollments = {
        sid: [to_obj(e) for e in raw_enrollments.get(str(sid), [])]
        for sid in section_ids
    }

    # Batch-fetch assignments for all sections
    notify_progress(job_id, {"status": "running", "stage": "assignments"})
    raw_assignments = _fetch_for_sections(auth, section_ids, "assignments", "assignment")
    assignments_by_section = defaultdict(list)
    for sid in section_ids:
        assignments_by_section[sid] = [to_obj(a) for a in raw_assignments.get(str(sid), [])]

    # Push per-section assignment lists to clients for the debug/stream view
    for section in sections:
        assigns = assignments_by_section[section.id]
        notify_progress(job_id, {
            "status": "running",
            "stage": "assignment_batch",
            "course": getattr(section, "course_title", "Unknown Course"),
            "assignments": [getattr(a, "title", f"Assignment {a.id}") for a in assigns],
        })

    logger.info("user_id=%s  sections=%d", user_id, len(sections))
    for section in sections:
        acount = len(assignments_by_section[section.id])
        sample_ids = [str(a.id) for a in assignments_by_section[section.id][:3]]
        logger.info("  section %s (%s): %d assignments, sample ids=%s",
                    section.id, getattr(section, "course_title", "?"), acount, sample_ids)

    # Batch-fetch submissions for all (section, assignment) pairs
    all_tasks = [
        (section.id, assignment.id)
        for section in sections
        for assignment in assignments_by_section[section.id]
    ]
    notify_progress(job_id, {"status": "running", "stage": "submissions", "total": len(all_tasks)})
    raw_submissions = _fetch_user_submissions(auth, all_tasks, user_id)

    latest_submissions: dict[str, SimpleNamespace] = {
        str(aid): obj
        for (sid, aid), obj in raw_submissions.items()
        if obj is not None
    }
    logger.info("latest_submissions: %d entries", len(latest_submissions))

    course_list = _build_student_assignments(auth, sections, assignments_by_section, latest_submissions, job_id)
    return {
        "mode": "student",
        "user_name": schoology_user["name"],
        "assignments": course_list,
    }


# In-memory store for mobile OAuth request tokens: request_token -> request_token_secret
# Entries expire after 10 minutes; cleaned up lazily.
_mobile_request_tokens: dict[str, tuple[str, float]] = {}
_MOBILE_TOKEN_TTL = 600  # seconds


def _store_mobile_request_token(request_token: str, request_token_secret: str):
    import time
    _mobile_request_tokens[request_token] = (request_token_secret, time.time())
    # Lazy cleanup of expired entries
    now = time.time()
    expired = [k for k, (_, ts) in _mobile_request_tokens.items() if now - ts > _MOBILE_TOKEN_TTL]
    for k in expired:
        del _mobile_request_tokens[k]


def _pop_mobile_request_token(request_token: str) -> str | None:
    entry = _mobile_request_tokens.pop(request_token, None)
    if entry is None:
        return None
    import time
    secret, ts = entry
    if time.time() - ts > _MOBILE_TOKEN_TTL:
        return None
    return secret


# Routes --------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/auth/start")
def auth_start():
    """Kick off Schoology OAuth."""
    if TWO_LEGGED_DEBUG:
        # Store debug credentials in session
        session["email"] = DEBUG_EMAIL
        session["access_token"] = SCHOOLOGY_CONSUMER_KEY
        session["access_token_secret"] = SCHOOLOGY_CONSUMER_SECRET
        session["two_legged"] = True
        return redirect("/recap")

    if not SCHOOLOGY_CONSUMER_KEY or not SCHOOLOGY_CONSUMER_SECRET:
        return "Missing Schoology API keys. Set SCHOOLOGY_CONSUMER_KEY/SECRET.", 500

    base_url = os.environ.get("PUBLIC_BASE_URL", "").rstrip("/")
    callback_url = base_url + "/auth/callback"
    auth = schoolopy.Auth(
        SCHOOLOGY_CONSUMER_KEY,
        SCHOOLOGY_CONSUMER_SECRET,
        three_legged=True,
        domain=SCHOOLOGY_DOMAIN,
    )
    url = auth.request_authorization(callback_url=callback_url)
    if auth.request_token and auth.request_token_secret:
        session["request_token"] = auth.request_token
        session["request_token_secret"] = auth.request_token_secret
    return redirect(url)


@app.route("/auth/mobile-start")
def auth_mobile_start():
    """
    Mobile OAuth entry point. Uses the same registered HTTP callback URL as the
    web flow — Schoology never sees a custom scheme. The server detects a mobile
    flow when /auth/callback receives a token that was registered here, then
    redirects to pinewoodrecap:// which ASWebAuthenticationSession intercepts.
    """
    if not SCHOOLOGY_CONSUMER_KEY or not SCHOOLOGY_CONSUMER_SECRET:
        return jsonify({"error": "missing_keys"}), 500

    base_url = os.environ.get("PUBLIC_BASE_URL", "").rstrip("/") or request.host_url.rstrip("/")
    callback_url = base_url + "/auth/callback"

    auth = schoolopy.Auth(
        SCHOOLOGY_CONSUMER_KEY,
        SCHOOLOGY_CONSUMER_SECRET,
        three_legged=True,
        domain=SCHOOLOGY_DOMAIN,
    )
    auth_url = auth.request_authorization(callback_url=callback_url)
    if auth.request_token and auth.request_token_secret:
        _store_mobile_request_token(auth.request_token, auth.request_token_secret)
    return jsonify({"auth_url": auth_url})


# In-memory store for mobile session codes: code -> {email, access_token, access_token_secret}
_mobile_session_codes: dict[str, tuple[dict, float]] = {}
_MOBILE_CODE_TTL = 120  # seconds


def _store_mobile_session_code(code: str, data: dict):
    _mobile_session_codes[code] = (data, time.time())
    now = time.time()
    expired = [k for k, (_, ts) in _mobile_session_codes.items() if now - ts > _MOBILE_CODE_TTL]
    for k in expired:
        del _mobile_session_codes[k]


def _pop_mobile_session_code(code: str) -> dict | None:
    entry = _mobile_session_codes.pop(code, None)
    if entry is None:
        return None
    data, ts = entry
    if time.time() - ts > _MOBILE_CODE_TTL:
        return None
    return data


@app.route("/auth/activate-code")
def auth_activate_code():
    """
    Called by the WKWebView after ASWebAuthenticationSession returns the temp code.
    Sets the Flask session (cookie) on the webview and redirects to /recap.
    """
    code = request.args.get("code")
    if not code:
        return redirect("/?error=missing_code")
    data = _pop_mobile_session_code(code)
    if not data:
        return redirect("/?error=invalid_code")
    session["email"] = data["email"]
    session["access_token"] = data["access_token"]
    session["access_token_secret"] = data["access_token_secret"]
    dest = "/recap?iosapp=1" if request.args.get("iosapp") == "1" else "/recap"
    return redirect(dest)


@app.route("/auth/callback")
def auth_callback():
    oauth_token = request.args.get("oauth_token")
    if not oauth_token:
        return redirect(url_for("index", error="missing_oauth_token"))

    # Detect mobile flow: request_token was registered via /auth/mobile-start
    is_mobile = oauth_token in _mobile_request_tokens

    if is_mobile:
        req_secret = _pop_mobile_request_token(oauth_token)
    else:
        req_token = session.pop("request_token", None)
        req_secret = session.pop("request_token_secret", None)
        if not req_token or oauth_token != req_token or not req_secret:
            return redirect(url_for("index", error="missing_request_secret"))

    auth = schoolopy.Auth(
        SCHOOLOGY_CONSUMER_KEY,
        SCHOOLOGY_CONSUMER_SECRET,
        three_legged=True,
        domain=SCHOOLOGY_DOMAIN,
        request_token=oauth_token,
        request_token_secret=req_secret,
    )

    if not auth.authorize():
        return redirect(url_for("index", error="authorize_failed"))

    access_token = auth.access_token
    access_token_secret = auth.access_token_secret

    # Rebuild oauth session with access tokens (schoolopy does not do this automatically)
    auth.oauth = requests_oauthlib.OAuth1Session(
        SCHOOLOGY_CONSUMER_KEY,
        client_secret=SCHOOLOGY_CONSUMER_SECRET,
        resource_owner_key=access_token,
        resource_owner_secret=access_token_secret,
    )

    # Fetch user to capture email
    sc = schoolopy.Schoology(auth)
    me = sc.get_me()
    email = getattr(me, "primary_email", None)

    if is_mobile:
        # Store session data under a short-lived code; redirect to the custom
        # scheme so ASWebAuthenticationSession intercepts it. The WKWebView will
        # then load /auth/activate-code to get the real session cookie.
        code = str(uuid.uuid4())
        _store_mobile_session_code(code, {
            "email": email,
            "access_token": access_token,
            "access_token_secret": access_token_secret,
        })
        return redirect(f"pinewoodrecap://auth/done?code={code}")

    # Web flow: store directly in Flask session and redirect.
    session["email"] = email
    session["access_token"] = access_token
    session["access_token_secret"] = access_token_secret
    return redirect("/recap")


@app.route("/recap")
def recap_index():
    """Landing page for /recap - checks for existing recap or starts new job."""
    email = session.get("email")
    if not email:
        return redirect("/")  # No auth, go to landing

    # Check for existing completed recap
    existing_recap = get_recap_by_email(email)

    # Check for in-progress job
    active_job = get_job_by_email(email)

    if existing_recap and not active_job:
        # Has completed recap, no job in progress - show existing screen
        return render_template("recap.html",
                             recap_id=existing_recap["id"],
                             email=email,
                             share_image_url=get_share_image_url(existing_recap["id"]),
                             show_existing=True,
                             is_generating=False)
    elif active_job:
        # Job in progress - redirect to job URL
        return redirect(f"/recap/{active_job['id']}")
    else:
        # No recap, no job - create new job and redirect
        job_id = str(uuid.uuid4())
        access_token = session.get("access_token")
        access_token_secret = session.get("access_token_secret")
        two_legged = session.get("two_legged", False)
        create_job(job_id, email, access_token, access_token_secret, two_legged=two_legged)
        return redirect(f"/recap/{job_id}")


@app.route("/recap/<recap_id>")
def recap_view(recap_id):
    """View specific recap (generating or completed)."""
    # Check if this is an active job
    job = get_job(recap_id)
    if job:
        # Job in progress
        return render_template("recap.html",
                             recap_id=recap_id,
                             email=job["email"],
                             share_image_url=get_share_image_url(recap_id),
                             show_existing=False,
                             is_generating=True)

    # Check if this is a completed recap
    recap = get_recap_by_id(recap_id)
    if recap:
        # Completed recap
        return render_template("recap.html",
                             recap_id=recap_id,
                             email=recap["email"],
                             share_image_url=get_share_image_url(recap_id),
                             show_existing=False,
                             is_generating=False)

    # Not found
    return "Recap not found", 404


@app.route("/api/recap/<recap_id>")
def get_recap_api(recap_id):
    """Get a completed recap by ID."""
    recap = get_recap_by_id(recap_id)
    if not recap:
        return jsonify({"error": "not_found"}), 404
    return jsonify(recap)


@app.route("/api/recap/delete", methods=["POST"])
def delete_recap_by_email():
    """Delete recap by email (for regeneration)."""
    email = session.get("email")
    if not email:
        return jsonify({"error": "not_authenticated"}), 401

    # Delete the existing recap for this email
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("DELETE FROM recaps WHERE email = ?", (email,))
    conn.commit()
    conn.close()

    return jsonify({"success": True})


# WebSocket for live progress updates
@sock.route("/ws/job/<job_id>")
def job_ws(ws, job_id):
    # Subscribe BEFORE reading initial state so no notification can slip through
    q = queue.Queue()
    subscribers.setdefault(job_id, []).append(q)

    try:
        # Send initial state; handle race where job finished before WS connected
        job = get_job(job_id)
        if job:
            ws.send(json.dumps({"status": job["status"], "progress": job["progress"]}))
        else:
            recap = get_recap_by_id(job_id)
            if recap and recap.get("slides"):
                # Job already done — tell client to fetch via HTTP (avoids sending huge payload)
                ws.send(json.dumps({"status": "done"}))
                return

        while True:
            try:
                payload = q.get(timeout=25)
            except queue.Empty:
                ws.send(json.dumps({"type": "heartbeat"}))
                continue
            # Strip slides from the WebSocket message — client fetches via HTTP on "done"
            if payload.get("status") == "done":
                ws.send(json.dumps({"status": "done"}))
            else:
                ws.send(json.dumps(payload))
            if payload.get("status") in ("done", "error"):
                break
    except Exception:
        logger.exception("WS error for job %s", job_id)
    finally:
        subs = subscribers.get(job_id, [])
        if q in subs:
            subs.remove(q)


@app.route("/terms")
def terms():
    return render_template("terms.html")


@app.route("/s/<username>")
def shared_recap(username):
    """Shared recap view for username (e.g., /s/28axu for 28axu@pinewood.edu)."""
    # Construct email from username
    email = f"{username}@pinewood.edu"

    # Look up recap by email
    recap = get_recap_by_email(email)
    if not recap or not recap.get("slides"):
        return "Recap not found", 404

    slides = recap["slides"] or {}
    grid_rel = (slides.get("share_images") or {}).get("grid")
    grid_abs = None
    if grid_rel and grid_rel.startswith("/"):
        grid_abs = os.path.join(app.root_path, grid_rel.lstrip("/"))
    if not grid_rel or not grid_abs or not os.path.exists(grid_abs):
        slides = generate_share_images(slides, recap["id"])
        update_recap_slides(recap["id"], slides)
        recap["slides"] = slides

    # Build recap URL for iframe
    base_url = os.environ.get("PUBLIC_BASE_URL", "").rstrip("/")
    if not base_url:
        base_url = request.host_url.rstrip("/")
    recap_url = f"{base_url}/recap/{recap['id']}"

    # Render shared recap template
    return render_template(
        "shared-recap.html",
        user_name=slides.get("user_name", ""),
        user_email=email,
        total_assignments=slides.get("total_assignments", 0),
        total_courses=slides.get("total_courses", 0),
        recap_url=recap_url,
        share_image_url=slides.get("share_images", {}).get("grid") and f"{base_url}{slides.get('share_images', {}).get('grid')}"
        or f"{base_url}/static/recap-card.png",
    )


if __name__ == "__main__":
    app.run(debug=True, port=5002)
