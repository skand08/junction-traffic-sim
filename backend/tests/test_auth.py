"""Sign-in: off by default; with a secret, every API call needs a session that ends with a password change
or a removed account."""
import os
import tempfile
import uuid

os.environ.setdefault("TRAFFICSIM_DATA", tempfile.mkdtemp(prefix="tsapi_"))

from fastapi.testclient import TestClient  # noqa: E402

from trafficsim import auth  # noqa: E402
from trafficsim.api import app  # noqa: E402


def test_sign_in_sessions_and_revocation(monkeypatch):
    assert TestClient(app).get("/api/auth/me").json() == {"enabled": False, "user": None}
    monkeypatch.setattr(auth, "SECRET", "test-secret-" + "x" * 20)
    monkeypatch.setattr(auth, "ENABLED", True)
    email = f"user_{uuid.uuid4().hex[:6]}@example.org"
    pw = auth.save_user(email.upper(), "Ada", admin=True)
    c = TestClient(app)
    assert c.get("/api/health").status_code == 200
    assert c.get("/api/scenarios").status_code == 401
    assert c.post("/api/auth/login", json=dict(email=email, password="wrong")).status_code == 401
    r = c.post("/api/auth/login", json=dict(email=email, password=pw))
    assert r.status_code == 200 and r.json()["user"] == dict(email=email, name="Ada", admin=True)
    assert c.get("/api/scenarios").status_code == 200
    old = c.cookies.get(auth.COOKIE)
    other = TestClient(app)
    other.cookies.set(auth.COOKIE, old[:-3] + "abc")
    assert other.get("/api/scenarios").status_code == 401                  # tampered cookie
    assert c.post("/api/auth/password", json=dict(current=pw, new="short")).status_code == 422
    assert c.post("/api/auth/password", json=dict(current=pw, new="a much longer one")).status_code == 200
    assert c.get("/api/scenarios").status_code == 200                      # this browser got a new session
    other.cookies.set(auth.COOKIE, old)
    assert other.get("/api/scenarios").status_code == 401                  # sessions from before the change end
    auth.remove_user(email)
    assert c.get("/api/scenarios").status_code == 401
    assert all(u["email"] != email for u in auth.users())
