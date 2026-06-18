"""
Temporary sunset patch — import this at the bottom of app.py to activate.
Replaces the home page with a closed-generation message.
Existing recap links (e.g. from email) still work via /recap/<id>.
"""

from flask import make_response, render_template, request, session
from app import app, get_recap_by_id, get_job


@app.route("/", endpoint="index")
def index():
    recap_id = session.get("recap_id")
    had_recap = False

    if recap_id:
        recap = get_recap_by_id(recap_id)
        if recap and recap.get("slides"):
            had_recap = True
        else:
            job = get_job(recap_id)
            if job:
                had_recap = True
            else:
                session.pop("recap_id", None)

    ios_app = request.args.get("iosapp") == "1" or request.cookies.get("iosapp") == "1"
    resp = make_response(render_template("skibidi.html", had_recap=had_recap, ios_app=ios_app))
    if request.args.get("iosapp") == "1":
        resp.set_cookie("iosapp", "1", max_age=60 * 60 * 24 * 365, samesite="Lax", httponly=True)
    return resp
