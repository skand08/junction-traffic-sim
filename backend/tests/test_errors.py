"""An unexpected server error answers with what failed, as JSON the app can show, not a bare 500 page."""
import os
import tempfile

os.environ.setdefault("TRAFFICSIM_DATA", tempfile.mkdtemp(prefix="tsapi_"))

from fastapi.testclient import TestClient  # noqa: E402

from trafficsim import api  # noqa: E402


def test_unexpected_error_is_reported_as_json(monkeypatch):
    def boom():
        raise RuntimeError("Vercel Blob: Missing Blob credentials")
    monkeypatch.setattr(api.sc, "list_all", boom)
    r = TestClient(api.app, raise_server_exceptions=False).get("/api/scenarios")
    assert r.status_code == 500
    assert r.json()["detail"] == "Server error: RuntimeError: Vercel Blob: Missing Blob credentials"
