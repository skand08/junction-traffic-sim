"""Sign-in for a shared deployment (a team of 10-20 people sharing one workspace).

Off unless JUNCTION_AUTH=on and JUNCTION_SECRET are both set (currently switched off on the deployment). When on, every /api request except signing in
and the health check needs a session cookie. Accounts are documents "users/<email>.json" with a scrypt password
hash; the cookie is signed with JUNCTION_SECRET and checked against the account on every request, so removing
an account or changing its password ends its sessions at once.

Everyone signed in sees and can change the same scenarios, runs and agents; there is no per-user data.

Manage accounts (from backend/, with the deployment's DATABASE_URL and JUNCTION_SECRET in the environment):
  python -m trafficsim.auth add alice@example.org [--name "Alice"] [--admin]   prints a generated password
  python -m trafficsim.auth passwd alice@example.org                          new generated password
  python -m trafficsim.auth remove alice@example.org
  python -m trafficsim.auth list
Or set JUNCTION_ADMIN_EMAIL and JUNCTION_ADMIN_PASSWORD: that account is created on start if no account exists.
"""
import base64
import hashlib
import hmac
import json
import os
import secrets
import sys
import time
from typing import Optional

from . import store

SECRET = os.environ.get("JUNCTION_SECRET", "")
# Sign-in is switched off for now: the app opens without a sign-in page even when JUNCTION_SECRET is set.
# To turn it back on, set JUNCTION_AUTH=on (with JUNCTION_SECRET) and redeploy.
ENABLED = bool(SECRET) and os.environ.get("JUNCTION_AUTH", "off").lower() == "on"
COOKIE = "junction_session"
SESSION_S = int(os.environ.get("JUNCTION_SESSION_DAYS", "14")) * 86400
OPEN = ("/api/auth/login", "/api/auth/logout", "/api/auth/me", "/api/health")


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def hash_password(pw: str) -> str:
    salt = secrets.token_bytes(16)
    h = hashlib.scrypt(pw.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
    return f"scrypt$16384$8$1${_b64(salt)}${_b64(h)}"


def check_password(pw: str, stored: str) -> bool:
    try:
        _, n, r, p, salt, h = stored.split("$")
        got = hashlib.scrypt(pw.encode(), salt=_unb64(salt), n=int(n), r=int(r), p=int(p), dklen=32)
        return hmac.compare_digest(got, _unb64(h))
    except (ValueError, TypeError):
        return False


def _key(email: str) -> str:
    email = email.strip().lower()
    if not email or "/" in email or "\\" in email or ".." in email or len(email) > 200:
        raise ValueError("Not a valid email address.")
    return f"users/{email}.json"


def get_user(email: str) -> Optional[dict]:
    try:
        return store.docs.read(_key(email))
    except (ValueError, KeyError):
        return None


def save_user(email: str, name: str = "", admin: bool = False, password: Optional[str] = None) -> str:
    """Create or update an account; returns its password (generated when none is given)."""
    pw = password or secrets.token_urlsafe(12)
    old = get_user(email) or {}
    store.docs.write(_key(email), dict(email=email.strip().lower(), name=name or old.get("name", ""),
                                      admin=admin or old.get("admin", False), password=hash_password(pw),
                                      created=old.get("created", time.time())))
    return pw


def remove_user(email: str):
    store.docs.delete(_key(email))


def users() -> list:
    return [{k: v for k, v in u.items() if k != "password"} for _, u in store.docs.items("users")]


def _sign(payload: str) -> str:
    return _b64(hmac.new(SECRET.encode(), payload.encode(), hashlib.sha256).digest())


def make_session(user: dict) -> str:
    # the password hash's last characters tie the session to the current password
    body = _b64(json.dumps(dict(u=user["email"], exp=int(time.time()) + SESSION_S, pv=user["password"][-12:])).encode())
    return f"{body}.{_sign(body)}"


def session_user(token: Optional[str]) -> Optional[dict]:
    if not token or "." not in token:
        return None
    body, sig = token.rsplit(".", 1)
    if not hmac.compare_digest(sig, _sign(body)):
        return None
    try:
        d = json.loads(_unb64(body))
    except (ValueError, json.JSONDecodeError):
        return None
    if d.get("exp", 0) < time.time():
        return None
    u = get_user(d.get("u", ""))
    if not u or u["password"][-12:] != d.get("pv"):
        return None
    return u


def public(u: dict) -> dict:
    return dict(email=u["email"], name=u.get("name") or u["email"].split("@")[0], admin=bool(u.get("admin")))


def bootstrap():
    """Create the first account from JUNCTION_ADMIN_EMAIL / JUNCTION_ADMIN_PASSWORD when there is none."""
    email, pw = os.environ.get("JUNCTION_ADMIN_EMAIL"), os.environ.get("JUNCTION_ADMIN_PASSWORD")
    if ENABLED and email and pw and not store.docs.items("users"):
        save_user(email, admin=True, password=pw)


def install(app):
    """Add the sign-in endpoints and the check on every API request."""
    from fastapi import HTTPException, Request
    from fastapi.responses import JSONResponse
    from pydantic import BaseModel

    class Login(BaseModel):
        email: str
        password: str

    class NewPassword(BaseModel):
        current: str
        new: str

    @app.middleware("http")
    async def require_session(request: Request, call_next):
        p = request.url.path
        if ENABLED and p.startswith("/api/") and not p.startswith(OPEN) and request.method != "OPTIONS":
            from starlette.concurrency import run_in_threadpool
            u = await run_in_threadpool(session_user, request.cookies.get(COOKIE))
            if u is None:
                return JSONResponse({"detail": "Sign in to continue."}, status_code=401)
            request.state.user = u
        return await call_next(request)

    def _cookie(resp, request: Request, value: str, max_age: int):
        secure = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
        resp.set_cookie(COOKIE, value, max_age=max_age, httponly=True, samesite="lax", secure=secure, path="/")

    @app.get("/api/auth/me")
    def me(request: Request):
        u = session_user(request.cookies.get(COOKIE)) if ENABLED else None
        return dict(enabled=ENABLED, user=public(u) if u else None)

    @app.post("/api/auth/login")
    def login(body: Login, request: Request):
        if not ENABLED:
            raise HTTPException(404, "Sign-in is not used on this server.")
        u = get_user(body.email)
        if not u or not check_password(body.password, u["password"]):
            time.sleep(1)                                   # slows down password guessing
            raise HTTPException(401, "That email and password do not match an account.")
        resp = JSONResponse(dict(enabled=True, user=public(u)))
        _cookie(resp, request, make_session(u), SESSION_S)
        return resp

    @app.post("/api/auth/logout")
    def logout(request: Request):
        resp = JSONResponse(dict(ok=True))
        _cookie(resp, request, "", 0)
        return resp

    @app.post("/api/auth/password")
    def change_password(body: NewPassword, request: Request):
        u = getattr(request.state, "user", None)
        if not u or not check_password(body.current, u["password"]):
            raise HTTPException(401, "The current password is not right.")
        if len(body.new) < 10:
            raise HTTPException(422, "Use at least 10 characters.")
        save_user(u["email"], password=body.new)
        resp = JSONResponse(dict(ok=True))
        _cookie(resp, request, make_session(get_user(u["email"])), SESSION_S)
        return resp


def _cli(argv: list):
    import argparse
    ap = argparse.ArgumentParser(prog="python -m trafficsim.auth", description="Manage accounts.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("add")
    a.add_argument("email")
    a.add_argument("--name", default="")
    a.add_argument("--admin", action="store_true")
    sub.add_parser("passwd").add_argument("email")
    sub.add_parser("remove").add_argument("email")
    sub.add_parser("list")
    args = ap.parse_args(argv)
    store.ready()
    if args.cmd == "add":
        if get_user(args.email):
            sys.exit(f"{args.email} already has an account (use passwd for a new password).")
        print(f"Created {args.email}. Password: {save_user(args.email, args.name, args.admin)}")
    elif args.cmd == "passwd":
        if not get_user(args.email):
            sys.exit(f"No account for {args.email}.")
        print(f"New password for {args.email}: {save_user(args.email)}")
    elif args.cmd == "remove":
        remove_user(args.email)
        print(f"Removed {args.email}.")
    else:
        for u in users():
            print(f"{u['email']:40} {u.get('name', ''):20} {'admin' if u.get('admin') else ''}")
    if not store.SHARED:
        print("Note: DATABASE_URL is not set, so this changed the local accounts only.", file=sys.stderr)


if __name__ == "__main__":
    _cli(sys.argv[1:])
