"""
Debug helper: list missing and late assignments for a specific course.

Usage:
  source env/bin/activate
  SECTION_ID=7928448629 DEBUG_USER_ID=<your_uid> python debug_missing_late.py

Env vars (or .env):
  SCHOOLOGY_CONSUMER_KEY / SCHOOLOGY_CONSUMER_SECRET
  SCHOOLOGY_DOMAIN (default https://app.schoology.com)
  SECTION_ID (required)
  DEBUG_USER_ID (optional override; otherwise uses /users/me if possible)
"""
import os
from datetime import datetime, timedelta

import schoolopy
from dotenv import load_dotenv
from requests_oauthlib import OAuth1Session


def parse_dt(value):
    if not value:
        return None
    if isinstance(value, (int, float)):
        try:
            return datetime.utcfromtimestamp(float(value))
        except Exception:
            return None
    if isinstance(value, str) and value.isdigit():
        try:
            return datetime.utcfromtimestamp(float(value))
        except Exception:
            return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(value, fmt)
        except Exception:
            continue
    return None


def get_auth():
    key = os.environ["SCHOOLOGY_CONSUMER_KEY"]
    secret = os.environ["SCHOOLOGY_CONSUMER_SECRET"]
    domain = os.environ.get("SCHOOLOGY_DOMAIN", "https://app.schoology.com")
    auth = schoolopy.Auth(key, secret, three_legged=False, domain=domain)
    sc = schoolopy.Schoology(auth)
    # rebuild oauth with consumer creds for direct calls
    auth.oauth = OAuth1Session(key, client_secret=secret)
    return sc, auth


def get_latest_user_revision(auth, section_id: str, assignment_id: str, user_id: str):
    """Fetch all revisions for assignment/user and return the latest entry."""
    url = f"https://api.schoology.com/v1/sections/{section_id}/submissions/{assignment_id}/{user_id}?all_revisions=true&with_attachments=true"
    resp = auth.oauth.get(url)
    if resp.status_code != 200:
        return None
    data = resp.json() or {}
    revs = data.get("revision") or data.get("submission") or []
    if isinstance(revs, dict) and "revision" in revs:
        revs = revs["revision"]
    if not isinstance(revs, list) or not revs:
        return None

    def ts(r):
        return parse_dt(r.get("submitted")) or parse_dt(r.get("created")) or datetime.min

    latest = max(revs, key=ts)
    latest["_ts"] = ts(latest)
    return latest


def main():
    load_dotenv()
    section_id = os.environ.get("SECTION_ID")
    if not section_id:
        raise SystemExit("SECTION_ID required")
    sc, auth = get_auth()

    # Determine user id
    user_id = os.environ.get("DEBUG_USER_ID")
    if not user_id:
        try:
            me = auth.oauth.get("https://api.schoology.com/v1/users/me")
            if me.status_code == 200:
                user_id = str(me.json().get("uid"))
        except Exception:
            pass
    if not user_id:
        raise SystemExit("No user id found; set DEBUG_USER_ID")

    now = datetime.utcnow()
    late = []
    missing = []

    # Pull assignments and grades for this section
    assignments = sc.get_assignments(section_id=section_id) or []
    grade_lookup = {}
    try:
        grades = sc.get_grades(section_id=section_id)
        for g in grades or []:
            aid = str(getattr(g, "assignment_id", "")) or str(getattr(g, "id", ""))
            if aid:
                try:
                    grade_lookup[aid] = float(getattr(g, "grade", 0))
                except Exception:
                    continue
    except Exception:
        pass

    for a in assignments:
        aid = str(getattr(a, "id", ""))
        due = parse_dt(getattr(a, "due", None))
        latest = get_latest_user_revision(auth, section_id, aid, user_id)
        submitted = parse_dt(latest.get("submitted")) or parse_dt(latest.get("created")) if latest else None
        is_late_flag = bool(latest and latest.get("late"))

        # Late: submitted exists and submitted > due or flag set
        if submitted and due and submitted > due or is_late_flag:
            late.append({
                "id": aid,
                "title": getattr(a, "title", ""),
                "due": due,
                "submitted": submitted,
                "late_flag": is_late_flag,
                "allow_dropbox": getattr(a, "allow_dropbox", "1") == "1",
            })

        # Missing: past due, no submission, grade present (any value)
        grade_val = grade_lookup.get(aid)
        if not submitted and getattr(a, "allow_dropbox", "1") == "1":
            missing.append({
                "id": aid,
                "title": getattr(a, "title", ""),
                "due": due,
                "grade": grade_val,
                "allow_dropbox": getattr(a, "allow_dropbox", "1") == "1",
            })
            print(f"Full JSON: {a}")

    print("\nLate assignments:")
    for item in late:
        print(f"- {item['title']} (id={item['id']}) due {item['due']} submitted {item['submitted']} late_flag={item['late_flag']}")

    print("\nMissing assignments (grade present, no submission):")
    for item in missing:
        print(f"- {item['title']} (id={item['id']}) due {item['due']} grade={item['grade']}")


if __name__ == "__main__":
    main()
