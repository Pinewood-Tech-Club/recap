"""
Recap MVP server.

Flow:
- GET /            : Landing page with CTA to connect Schoology
- GET /auth/start  : Begin three-legged OAuth
- GET /auth/callback : Complete OAuth and return to index
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
    make_response,
    session,
    send_from_directory,
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
import galleries as galleries_module

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)


class RecapDataError(Exception):
    """Raised when user data is missing or inaccessible (e.g. privacy settings)."""
logger = logging.getLogger(__name__)

app = Flask(__name__)
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "dev-secret-key")
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)  # trust reverse proxy for scheme/host
sock = Sock(app)

PHOTOS_BASE_URL = os.environ.get("PHOTOS_BASE_URL", "https://photos.recap.pinewood.one")
galleries_module.start(PHOTOS_BASE_URL)

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

subscribers: dict[str, list[queue.Queue]] = {}
subscribers_lock = threading.Lock()
job_creation_lock = threading.Lock()

if not SCHOOLOGY_CONSUMER_KEY or not SCHOOLOGY_CONSUMER_SECRET:
    logger.warning("Schoology consumer key/secret missing; OAuth will fail.")

with open(os.path.join(os.path.dirname(__file__), "pinewood_roles.json")) as f:
    _role_data = json.load(f)
FACULTY_ROLE_IDS = {r["id"] for r in _role_data["role"] if r["faculty"] == 1}

with open(os.path.join(os.path.dirname(__file__), "sports.json")) as f:
    _sports_data = json.load(f)

# Maps sport name (from sports.json) -> categories.json slug(s) to pull albums from
_SPORT_SLUG_MAP: dict[str, list[str]] = {
    "Cross Country":       ["sports/cross-country"],
    "Girls Flag Football": ["sports/football/girls-flag"],
    "Girls Volleyball":    ["sports/volleyball/girls"],
    "Football":            ["sports/football/boys"],
    "Girls Tennis":        ["sports/tennis/girls"],
    "Boys Soccer":         ["sports/soccer/boys"],
    "Girls Soccer":        ["sports/soccer/girls"],
    "Boys Basketball":     ["sports/basketball/boys"],
    "Girls Basketball":    ["sports/basketball/girls"],
    "Boys Tennis":         ["sports/tennis/boys"],
    "Boys Baseball":       ["sports/baseball"],
}

_ROBOTICS_SLUGS = ["robotics/sf-district", "robotics/cv-district", "robotics/misc"]

with open(os.path.join(os.path.dirname(__file__), "performing_arts.json")) as f:
    _performing_arts_data = json.load(f)

_PERFORMING_ARTS_SLUG_MAP: dict[str, list[str]] = {
    "spring_musical": ["performing-arts/spring-musical"],
    "fall_play":      ["performing-arts/fall-play"],
}

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


def requeue_interrupted_jobs():
    """Recover jobs left running by a stopped server process."""
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("UPDATE jobs SET status = 'queued' WHERE status = 'running'")
    count = cur.rowcount
    conn.commit()
    conn.close()
    if count:
        logger.info("Requeued %d interrupted recap job(s)", count)


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


def list_active_jobs():
    """List queued/running jobs in user-facing queue order."""
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT id, email, status, progress_json, created_at
        FROM jobs
        WHERE status IN ('running', 'queued')
        ORDER BY
            CASE status WHEN 'running' THEN 0 ELSE 1 END,
            created_at ASC
        """
    )
    rows = cur.fetchall()
    conn.close()
    jobs = []
    for row in rows:
        try:
            progress = json.loads(row[3]) if row[3] else None
        except json.JSONDecodeError:
            progress = None
        jobs.append({
            "id": row[0],
            "email": row[1],
            "status": row[2],
            "progress": progress,
            "created_at": row[4],
        })
    return jobs


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
    """Persist the latest non-terminal job progress."""
    if payload.get("status") not in ["done", "error"]:
        update_job_progress(job_id, payload)
    if payload.get("status") == "error":
        message = {
            "type": "job_status",
            "recap_id": job_id,
            "status": "error",
            "queue_position": None,
            "ahead_count": None,
            "active_count": len(list_active_jobs()),
            "percent": estimate_job_percent("error", payload),
            "progress": payload,
            "ready_url": None,
        }
    else:
        message = get_job_status_snapshot(job_id)
    broadcast_job_status(job_id, message)


def ensure_background_recap_job(email, access_token, access_token_secret, two_legged=False):
    """Start recap generation unless this email already has a recap or active job."""
    if not email:
        return None

    with job_creation_lock:
        existing_recap = get_recap_by_email(email)
        if existing_recap and existing_recap.get("slides"):
            session["recap_id"] = existing_recap["id"]
            return existing_recap["id"]
        active_job = get_job_by_email(email)
        if active_job:
            session["recap_id"] = active_job["id"]
            return active_job["id"]

        job_id = str(uuid.uuid4())
        create_job(job_id, email, access_token, access_token_secret, two_legged=two_legged)
        session["recap_id"] = job_id
        logger.info("Queued background recap job %s for %s", job_id, email)
        return job_id


def estimate_job_percent(status, progress):
    """Return rough generation progress as an integer percentage."""
    if status == "done":
        return 100
    if status in ("error", "missing"):
        return 0
    if status == "queued":
        return 0
    if status != "running":
        return 0

    progress = progress or {}
    if progress.get("message") == "Starting job":
        return 5

    stage = progress.get("stage")
    stage_percent = {
        "me": 10,
        "sections": 15,
        "enrollments": 25,
        "assignments": 35,
        "grades": 70,
        "activities": 88,
    }
    if stage == "submissions":
        # Real progress: count/total tracked per-request in _fetch_user_submissions
        pct = progress.get("percent")
        if isinstance(pct, (int, float)):
            return int(pct)
        count = progress.get("count", 0)
        total = progress.get("total", 0)
        if total > 0:
            return 35 + round((count / total) * 50)
        return 35
    if stage == "assignment_batch":
        count = progress.get("count")
        total = progress.get("total")
        if isinstance(count, (int, float)) and isinstance(total, (int, float)) and total > 0:
            return min(34, 15 + round((count / total) * 20))
        return 25
    if stage in stage_percent:
        return stage_percent[stage]
    return 5


def get_job_status_snapshot(job_id):
    """Return the current websocket status payload for a recap/job id."""
    active_jobs = list_active_jobs()
    active_count = len(active_jobs)
    for idx, job in enumerate(active_jobs):
        if job["id"] == job_id:
            return {
                "type": "job_status",
                "recap_id": job_id,
                "status": job["status"],
                "queue_position": idx + 1,
                "ahead_count": idx,
                "active_count": active_count,
                "percent": estimate_job_percent(job["status"], job.get("progress")),
                "progress": job.get("progress"),
                "ready_url": None,
            }

    recap = get_recap_by_id(job_id)
    if recap and recap.get("slides"):
        return {
            "type": "job_status",
            "recap_id": job_id,
            "status": "done",
            "queue_position": None,
            "ahead_count": 0,
            "active_count": active_count,
            "percent": 100,
            "progress": None,
            "ready_url": f"/recap/{job_id}",
        }

    return {
        "type": "job_status",
        "recap_id": job_id,
        "status": "missing",
        "queue_position": None,
        "ahead_count": None,
        "active_count": active_count,
        "percent": 0,
        "progress": None,
        "ready_url": None,
    }


def subscribe_job(job_id, q):
    with subscribers_lock:
        subscribers.setdefault(job_id, []).append(q)


def unsubscribe_job(job_id, q):
    with subscribers_lock:
        subs = subscribers.get(job_id)
        if not subs:
            return
        if q in subs:
            subs.remove(q)
        if not subs:
            subscribers.pop(job_id, None)


def broadcast_job_status(job_id, message):
    with subscribers_lock:
        subs = list(subscribers.get(job_id, []))

    stale = []
    for q in subs:
        try:
            q.put_nowait(message)
        except queue.Full:
            stale.append(q)
        except Exception:
            stale.append(q)

    for q in stale:
        unsubscribe_job(job_id, q)


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
    """Send recap-ready email. Tries Gmail SMTP first, then SES, then logs."""
    if not email:
        return

    base_url = os.environ.get("PUBLIC_BASE_URL", "").rstrip("/")
    recap_link = f"{base_url}/recap/{job_id}" if base_url else f"/recap/{job_id}"

    subject = "Your Schoology Recap is ready!"
    body_text = f"Hi! Your Pinewood Schoology Recap is ready to view.\n\nView it here: {recap_link}\n\n— Pinewood Tech Club"
    body_html = f"""<div style="font-family:sans-serif">
  <h2 style="font-size:2rem;margin-bottom:8px">Your Recap is ready!</h2>
  <p style="color:#444;font-size: 1.2rem">Your Pinewood Schoology Recap has finished generating. Here's a link to it!</p>
  <a href="{recap_link}" style="display:inline-block;margin:16px 0;padding:12px 20px;background:#2d6a2d;color:#fff;border-radius:10px;text-decoration:none;font-weight:700">View Your Recap</a>
  <p style="color:#888;font-size:12px"><a href="{recap_link}" style="color:#888">{recap_link}</a></p>
  <p style="color:#444;line-height:1.6; font-size: 1.2rem">From the <a style="color: #2d6a2d" href="https://techclub.pw">Pinewood Tech Club</a></p>
</div>"""

    # ── Gmail SMTP ──────────────────────────────────────────────────────────
    smtp_user = os.environ.get("SMTP_USER")
    smtp_pass = os.environ.get("SMTP_PASSWORD")
    smtp_from = os.environ.get("SMTP_FROM", smtp_user)

    if smtp_user and smtp_pass:
        try:
            import smtplib
            from email.mime.multipart import MIMEMultipart
            from email.mime.text import MIMEText

            msg = MIMEMultipart("alternative")
            msg["Subject"] = subject
            msg["From"] = f"Pinewood Tech Club <{smtp_from}>"
            msg["To"] = email
            msg.attach(MIMEText(body_text, "plain"))
            msg.attach(MIMEText(body_html, "html"))

            with smtplib.SMTP("smtp.gmail.com", 587) as server:
                server.starttls()
                server.login(smtp_user, smtp_pass)
                server.sendmail(smtp_from, email, msg.as_string())

            logger.info("SMTP email sent to %s for recap %s", email, job_id)
            return
        except Exception as exc:  # pylint: disable=broad-except
            logger.exception("SMTP email failed; trying SES: %s", exc)

    # ── AWS SES fallback ────────────────────────────────────────────────────
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
                    "Subject": {"Data": subject},
                    "Body": {"Text": {"Data": body_text}, "Html": {"Data": body_html}},
                },
            )
            logger.info("SES email sent to %s for recap %s", email, job_id)
            return
        except Exception as exc:  # pylint: disable=broad-except
            logger.exception("SES email failed: %s", exc)

    logger.info("No email transport configured; recap ready for %s: %s", email, recap_link)


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
            # Delete job from queue (OAuth tokens deleted)
            delete_job(job_id)
            # Notify completion after deletion so active_count excludes this job.
            notify_progress(job_id, {"status": "done"})
            send_recap_email(job["email"], job_id)
        except RecapDataError as exc:
            logger.warning("Job %s: no data — %s", job_id, exc)
            notify_progress(job_id, {"status": "error", "error_type": "no_data", "error": str(exc)})
            delete_job(job_id)
        except Exception as exc:  # pylint: disable=broad-except
            logger.exception("Job %s failed", job_id)
            notify_progress(job_id, {"status": "error", "error": str(exc)})
            delete_job(job_id)


requeue_interrupted_jobs()
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


def _fetch_user_submissions(auth, tasks, user_id, progress_cb=None):
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
    total = len(tasks)
    completed = 0
    last_reported_pct = [-1]  # track last sent % to avoid flooding

    # max_workers=3 keeps us under Schoology's 15-req/5s rate limit
    with ThreadPoolExecutor(max_workers=3) as executor:
        futures = {executor.submit(_fetch_one, sid, aid): (sid, aid) for sid, aid in tasks}
        for future in as_completed(futures):
            (sid, aid), status, data = future.result()
            completed += 1
            if progress_cb and total > 0:
                pct = 35 + round((completed / total) * 50)
                if pct >= last_reported_pct[0] + 2 or completed == total:
                    last_reported_pct[0] = pct
                    progress_cb(completed, total, pct)

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
            due_raw = getattr(a, "due", None)
            due_ts = None
            if due_raw:
                parsed_due = parse_dt(due_raw)
                if parsed_due:
                    due_ts = int(parsed_due.replace(tzinfo=None).timestamp())
            events.append({"t": ts, "due": due_ts})
        course_list.append({"course": course_title, "data": events})
    return course_list


def _analyze_image(image_url: str, bbox: list | None = None) -> dict:
    """Fetch image once; return l_d and face_pos {x, y} as percentages."""
    result = {"l_d": "dark", "face_pos": None}
    try:
        from PIL import Image
        import io as _io
        resp = requests.get(image_url, timeout=15)
        resp.raise_for_status()
        img = Image.open(_io.BytesIO(resp.content)).convert("L")
        w, h = img.size
        bottom = img.crop((0, int(h * 0.65), w, h))
        pixels = list(bottom.getdata())
        avg = sum(pixels) / (len(pixels) * 255)
        result["l_d"] = "light" if avg > 0.5 else "dark"
        if bbox and len(bbox) == 4 and w and h:
            cx = (bbox[0] + bbox[2]) / 2
            cy = (bbox[1] + bbox[3]) / 2
            result["face_pos"] = {"x": round(cx / w * 100, 2), "y": round(cy / h * 100, 2)}
    except Exception as exc:
        logger.warning("_analyze_image failed for %s: %s", image_url, exc)
    return result


def _photos_for_slugs(slugs: list[str]) -> list[str]:
    """Return all photo paths belonging to the given category slugs."""
    slug_albums  = galleries_module.get_slug_albums()
    album_photos = galleries_module.get_album_photos()
    paths: list[str] = []
    for slug in slugs:
        for album in slug_albums.get(slug, []):
            paths.extend(album_photos.get(album, []))
    return paths


def _best_photo_for_user(username: str, candidate_paths: list[str], member_set: set[str]) -> str | None:
    """
    Pick the best photo from candidate_paths for username.
    Priority: fewest other identified faces → highest recognition score.
    Fallback: photo with most member_set faces.
    """
    if not candidate_paths:
        return None

    photo_faces = galleries_module.get_photo_faces()
    raw_meta    = galleries_module.get_raw_metadata()
    path_set    = set(candidate_paths)

    user_appearances = {
        a["photo"]: a
        for a in raw_meta.get(username, {}).get("appearances", [])
        if a["photo"] in path_set
    }

    if user_appearances:
        def _key(item):
            path, app = item
            other = len([n for n in photo_faces.get(path, []) if n != username])
            return (other, -app.get("score", 0.0))
        return min(user_appearances.items(), key=_key)[0]

    # Fallback: most team-member faces
    return max(candidate_paths, key=lambda p: sum(1 for n in photo_faces.get(p, []) if n in member_set), default=None)


def _find_sport_photo(username: str, sport_name: str, sport_members: list[str]) -> str | None:
    slugs = _SPORT_SLUG_MAP.get(sport_name)
    if not slugs:
        return None
    paths = _photos_for_slugs(slugs)
    return _best_photo_for_user(username, paths, set(sport_members))


def _find_robotics_photo(username: str, all_members: list[str]) -> str | None:
    paths = _photos_for_slugs(_ROBOTICS_SLUGS)
    return _best_photo_for_user(username, paths, set(all_members))


def _build_activities(username: str) -> list[dict]:
    """Return activity slides for an HS student (grades 26-29), or []."""
    import re
    if not re.match(r"^(26|27|28|29)", username):
        return []

    if not galleries_module.wait_ready(timeout=30):
        logger.warning("Galleries not ready; skipping activities for %s", username)
        return []

    activities = []
    raw_meta = galleries_module.get_raw_metadata()

    def _bbox_for(uname, path):
        apps = {a["photo"]: a for a in raw_meta.get(uname, {}).get("appearances", [])}
        a = apps.get(path)
        return a.get("bbox") if a else None

    # Sports
    for season, sport_list in [("fall", _sports_data["fall"]),
                                ("winter", _sports_data["winter"]),
                                ("spring", _sports_data["spring"])]:
        for sport in sport_list:
            if username not in sport["members"]:
                continue
            photo_path = _find_sport_photo(username, sport["name"], sport["members"])
            if not photo_path:
                continue
            image_url = f"{PHOTOS_BASE_URL}/{photo_path}"
            analysis = _analyze_image(image_url, _bbox_for(username, photo_path))
            activities.append({
                "type": "sport",
                "dat": {
                    "season": season,
                    "sport": sport["name"],
                    "image_url": image_url,
                    "l_d": analysis["l_d"],
                    "face_pos": analysis["face_pos"],
                },
            })

    # Robotics
    with open(os.path.join(os.path.dirname(__file__), "robotics.json")) as _f:
        _robotics = json.load(_f)
    all_robotics_members = _robotics.get("members", []) + _robotics.get("kinda_members", [])
    if username in all_robotics_members:
        photo_path = _find_robotics_photo(username, all_robotics_members)
        if photo_path:
            image_url = f"{PHOTOS_BASE_URL}/{photo_path}"
            analysis = _analyze_image(image_url, _bbox_for(username, photo_path))
            activities.append({
                "type": "robotics",
                "dat": {
                    "image_url": image_url,
                    "face_pos": analysis["face_pos"],
                },
            })

    # Performing Arts
    _SHOW_META = {
        "spring_musical": {"label": "Spring Musical", "season": "spring"},
        "fall_play":       {"label": "Fall Play",      "season": "fall"},
    }
    for show_key, show_info in _SHOW_META.items():
        members = _performing_arts_data.get(show_key, {}).get("members", [])
        if not members or username not in members:
            continue
        slugs = _PERFORMING_ARTS_SLUG_MAP.get(show_key, [])
        paths = _photos_for_slugs(slugs)
        photo_path = _best_photo_for_user(username, paths, set(m for m in members if m))
        if not photo_path:
            continue
        image_url = f"{PHOTOS_BASE_URL}/{photo_path}"
        analysis = _analyze_image(image_url, _bbox_for(username, photo_path))
        activities.append({
            "type": "performing_arts",
            "dat": {
                "label": show_info["label"],
                "season": show_info["season"],
                "image_url": image_url,
                "l_d": analysis["l_d"],
                "face_pos": analysis["face_pos"],
            },
        })

    return activities


def _compute_senioritis(assignments_by_section, latest_submissions):
    """Compute 0-100 senioritis score for class of 2026 students."""
    RANGE_START_TS = int(datetime(2026, 1, 7).timestamp())
    RANGE_END_TS   = int(datetime(2026, 5, 19, 23, 59, 59).timestamp())
    now_ts = int(datetime.utcnow().timestamp())

    total_with_due = 0
    missing = 0
    late_count = 0
    last_minute = 0
    night_owl = 0
    total_subs = 0

    for sid, assigns in assignments_by_section.items():
        for a in assigns:
            due_raw = getattr(a, "due", None)
            if not due_raw:
                continue
            due_dt = parse_dt(due_raw)
            if not due_dt:
                continue
            due_ts = int(due_dt.replace(tzinfo=None).timestamp())
            if due_ts < RANGE_START_TS or due_ts > RANGE_END_TS:
                continue
            if due_ts > now_ts:
                continue
            total_with_due += 1

            sub = latest_submissions.get(str(a.id))
            if not sub:
                missing += 1
                continue

            raw_sub = getattr(sub, "submitted", None) or getattr(sub, "created", None)
            if not raw_sub:
                missing += 1
                continue

            if isinstance(raw_sub, (int, float)):
                sub_ts = int(raw_sub)
            elif isinstance(raw_sub, str) and raw_sub.isdigit():
                sub_ts = int(raw_sub)
            else:
                sub_dt = parse_dt(raw_sub)
                if not sub_dt:
                    missing += 1
                    continue
                sub_ts = int(sub_dt.replace(tzinfo=None).timestamp())

            total_subs += 1

            if sub_ts > due_ts:
                late_count += 1
            elif 0 <= (due_ts - sub_ts) <= 3600:
                last_minute += 1

            # Night owl: PST = UTC-8
            pst_hour = (datetime.utcfromtimestamp(sub_ts).hour - 8) % 24
            if pst_hour >= 22 or pst_hour < 6:
                night_owl += 1

    if total_with_due == 0:
        return None

    missing_pct = missing / total_with_due
    late_pct    = late_count / total_with_due
    lm_pct      = last_minute / total_with_due
    night_pct   = night_owl / max(total_subs, 1)

    score = round(
        min(missing_pct * 150, 40) +
        min(late_pct    * 150, 25) +
        min(lm_pct      *  80, 20) +
        min(night_pct   *  60, 15)
    )
    return {
        "score":       max(0, min(100, score)),
        "total":       total_with_due,
        "missing":     missing,
        "late":        late_count,
        "last_minute": last_minute,
        "missing_pct": round(missing_pct * 100),
        "late_pct":    round(late_pct * 100),
        "lm_pct":      round(lm_pct * 100),
    }


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

    if not sections:
        raise RecapDataError("No Schoology sections found. This may be due to account privacy settings.")

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

    total_assignments_found = sum(len(v) for v in assignments_by_section.values())
    if total_assignments_found == 0:
        raise RecapDataError("No assignments found across all sections. This may be due to account privacy settings.")

    # Push per-section assignment lists to clients for the debug/stream view
    total_sections = len(sections)
    for idx, section in enumerate(sections, start=1):
        assigns = assignments_by_section[section.id]
        notify_progress(job_id, {
            "status": "running",
            "stage": "assignment_batch",
            "course": getattr(section, "course_title", "Unknown Course"),
            "count": idx,
            "total": total_sections,
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
    notify_progress(job_id, {"status": "running", "stage": "submissions", "count": 0, "total": len(all_tasks), "percent": 35})

    def _sub_progress(count, total, pct):
        notify_progress(job_id, {"status": "running", "stage": "submissions", "count": count, "total": total, "percent": pct})

    raw_submissions = _fetch_user_submissions(auth, all_tasks, user_id, progress_cb=_sub_progress)

    latest_submissions: dict[str, SimpleNamespace] = {
        str(aid): obj
        for (sid, aid), obj in raw_submissions.items()
        if obj is not None
    }
    logger.info("latest_submissions: %d entries", len(latest_submissions))

    course_list = _build_student_assignments(auth, sections, assignments_by_section, latest_submissions, job_id)

    username = (user_email or "").split("@")[0]
    notify_progress(job_id, {"status": "running", "stage": "activities"})
    activities = _build_activities(username)

    senioritis = None
    if username.startswith("26"):
        senioritis = _compute_senioritis(assignments_by_section, latest_submissions)

    return {
        "mode": "student",
        "user_name": schoology_user["name"],
        "assignments": course_list,
        "activities": activities,
        "senioritis": senioritis,
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
    recap_id = session.get("recap_id")
    user_name = None
    recap_ready = False
    if recap_id:
        recap = get_recap_by_id(recap_id)
        if recap and recap.get("slides"):
            user_name = recap["slides"].get("user_name")
            recap_ready = True
        else:
            job = get_job(recap_id)
            if job:
                user_name = (job["email"] or "").split("@")[0]
            else:
                session.pop("recap_id", None)
                recap_id = None
    ios_app = request.args.get("iosapp") == "1" or request.cookies.get("iosapp") == "1"
    error = request.args.get("error")
    resp = make_response(render_template("index.html", user_name=user_name, recap_id=recap_id, recap_ready=recap_ready, ios_app=ios_app, error=error))
    if request.args.get("iosapp") == "1":
        resp.set_cookie("iosapp", "1", max_age=60*60*24*365, samesite="Lax", httponly=True)
    return resp


@app.route("/auth/logout")
def auth_logout():
    session.clear()
    return redirect("/")


@app.route("/auth/start")
def auth_start():
    """Kick off Schoology OAuth."""
    if TWO_LEGGED_DEBUG:
        # Store debug credentials in session
        session["email"] = DEBUG_EMAIL
        session["access_token"] = SCHOOLOGY_CONSUMER_KEY
        session["access_token_secret"] = SCHOOLOGY_CONSUMER_SECRET
        session["two_legged"] = True
        ensure_background_recap_job(
            DEBUG_EMAIL,
            SCHOOLOGY_CONSUMER_KEY,
            SCHOOLOGY_CONSUMER_SECRET,
            two_legged=True,
        )
        return redirect("/")

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
    Sets the Flask session (cookie) on the webview and redirects back to the
    landing page for the iOS wrapper so opening/signing in does not immediately
    launch or generate the recap.
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
    ensure_background_recap_job(
        data["email"],
        data["access_token"],
        data["access_token_secret"],
    )
    is_ios = request.args.get("iosapp") == "1" or request.cookies.get("iosapp") == "1"
    dest = "/?iosapp=1" if is_ios else "/"
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

    if not email or not email.endswith("@pinewood.edu"):
        return redirect(url_for("index", error="invalid_domain"))

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
    ensure_background_recap_job(email, access_token, access_token_secret)
    return redirect("/")


@app.route("/recap")
def recap_index():
    """Recap generation/viewing is disabled for phase 1; return to index."""
    return redirect("/")


def _build_demo_activities() -> list[dict]:
    """Pick one random person per sport/activity who has a photo, return all activity slides."""
    import random
    if not galleries_module.wait_ready(timeout=30):
        return []
    raw_meta = galleries_module.get_raw_metadata()

    def _bbox_for(uname, path):
        apps = {a["photo"]: a for a in raw_meta.get(uname, {}).get("appearances", [])}
        a = apps.get(path)
        return a.get("bbox") if a else None

    activities = []

    # Sports
    for season, sport_list in [("fall", _sports_data["fall"]),
                                ("winter", _sports_data["winter"]),
                                ("spring", _sports_data["spring"])]:
        for sport in sport_list:
            members = [m for m in sport["members"] if m]
            random.shuffle(members)
            for username in members:
                photo_path = _find_sport_photo(username, sport["name"], sport["members"])
                if not photo_path:
                    continue
                image_url = f"{PHOTOS_BASE_URL}/{photo_path}"
                analysis = _analyze_image(image_url, _bbox_for(username, photo_path))
                activities.append({
                    "type": "sport",
                    "dat": {
                        "season": season,
                        "sport": sport["name"],
                        "image_url": image_url,
                        "l_d": analysis["l_d"],
                        "face_pos": analysis["face_pos"],
                    },
                })
                break

    # Robotics
    with open(os.path.join(os.path.dirname(__file__), "robotics.json")) as _f:
        _robotics = json.load(_f)
    all_robotics_members = [m for m in _robotics.get("members", []) + _robotics.get("kinda_members", []) if m]
    random.shuffle(all_robotics_members)
    for username in all_robotics_members:
        photo_path = _find_robotics_photo(username, all_robotics_members)
        if not photo_path:
            continue
        image_url = f"{PHOTOS_BASE_URL}/{photo_path}"
        analysis = _analyze_image(image_url, _bbox_for(username, photo_path))
        activities.append({
            "type": "robotics",
            "dat": {"image_url": image_url, "face_pos": analysis["face_pos"]},
        })
        break

    # Performing Arts
    _SHOW_META = {
        "spring_musical": {"label": "Spring Musical", "season": "spring"},
        "fall_play":       {"label": "Fall Play",      "season": "fall"},
    }
    for show_key, show_info in _SHOW_META.items():
        members = [m for m in _performing_arts_data.get(show_key, {}).get("members", []) if m]
        if not members:
            continue
        slugs = _PERFORMING_ARTS_SLUG_MAP.get(show_key, [])
        paths = _photos_for_slugs(slugs)
        random.shuffle(members)
        for username in members:
            photo_path = _best_photo_for_user(username, paths, set(members))
            if not photo_path:
                continue
            image_url = f"{PHOTOS_BASE_URL}/{photo_path}"
            analysis = _analyze_image(image_url, _bbox_for(username, photo_path))
            activities.append({
                "type": "performing_arts",
                "dat": {
                    "label": show_info["label"],
                    "season": show_info["season"],
                    "image_url": image_url,
                    "l_d": analysis["l_d"],
                    "face_pos": analysis["face_pos"],
                },
            })
            break

    return activities


@app.route("/recap/demo")
def recap_demo_view():
    return render_template("recap.html", recap_id="demo", email="demo@pinewood.edu",
                           gallery_name="demo", share_image_url=None)


@app.route("/api/recap/demo")
def recap_demo_api():
    import random, math
    # Fake assignment events spread across Jan–May 2026
    range_start = datetime(2026, 1, 7)
    range_end   = datetime(2026, 5, 19)
    span_days   = (range_end - range_start).days
    courses = ["AP English", "AP Calculus BC", "AP US History", "AP Chemistry", "AP CS Principles", "Spanish 4"]
    assignments = []
    for course in courses:
        n = random.randint(18, 35)
        events = []
        for _ in range(n):
            day_offset = random.randint(0, span_days)
            hour = random.choices(range(24), weights=[1,1,1,1,1,1,2,3,4,5,6,7,8,9,10,10,9,8,8,9,9,8,5,2], k=1)[0]
            ts = int((range_start + timedelta(days=day_offset, hours=hour, minutes=random.randint(0,59))).timestamp())
            due_offset = random.randint(3600, 86400 * 3)
            events.append({"t": ts, "due": ts + due_offset})
        assignments.append({"course": course, "data": events})

    activities = _build_demo_activities()

    slides = {
        "mode": "student",
        "user_name": "Demo Student",
        "assignments": assignments,
        "activities": activities,
        "senioritis": {
            "score":       67,
            "total":       85,
            "missing":     8,
            "late":        11,
            "last_minute": 14,
            "missing_pct": 9,
            "late_pct":    13,
            "lm_pct":      16,
        },
    }
    return jsonify({"id": "demo", "slides": slides})


@app.route("/recap/<recap_id>")
def recap_view(recap_id):
    """Render completed recaps; generating or missing recap URLs return to index."""
    recap = get_recap_by_id(recap_id)
    if not recap or not recap.get("slides"):
        return redirect("/")
    if recap["email"] == session.get("email"):
        session["recap_id"] = recap_id
    return render_template(
        "recap.html",
        recap_id=recap_id,
        email=recap["email"],
        gallery_name=recap["email"].split("@")[0],
        share_image_url=get_share_image_url(recap_id),
    )


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


@sock.route("/ws/job/<job_id>")
def job_ws(ws, job_id):
    q = queue.Queue(maxsize=20)
    subscribe_job(job_id, q)
    try:
        initial = get_job_status_snapshot(job_id)
        ws.send(json.dumps(initial))
        if initial.get("status") in ("done", "error", "missing"):
            return

        while True:
            try:
                message = q.get(timeout=10)
            except queue.Empty:
                message = get_job_status_snapshot(job_id)

            ws.send(json.dumps(message))
            if message.get("status") in ("done", "error", "missing"):
                break
    except Exception as exc:  # pylint: disable=broad-except
        logger.info("WS closed for job %s: %s", job_id, exc)
    finally:
        unsubscribe_job(job_id, q)


@app.route("/photos")
@app.route("/photos/")
def photos():
    return send_from_directory("static/photos", "index.html")


@app.route("/photos/selection/<name>.json")
def photos_selection(name):
    if not galleries_module.is_ready():
        return {"error": "galleries building, try again shortly"}, 503
    data = galleries_module.get_selection(name)
    if data is None:
        return {"error": "not found"}, 404
    from flask import jsonify
    return jsonify(data)


@app.route("/photos/gallery/<name>.json")
def photos_gallery(name):
    if not galleries_module.is_ready():
        return {"error": "galleries building, try again shortly"}, 503
    data = galleries_module.get_gallery(name)
    if data is None:
        return {"error": "not found"}, 404
    from flask import jsonify
    return jsonify(data)


@app.route("/photos/<path:path>")
def photos_assets(path):
    return send_from_directory("static/photos", path)


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
    is_prod = os.environ.get("PROD") == "1"
    app.run(debug=not is_prod, port=5002)
