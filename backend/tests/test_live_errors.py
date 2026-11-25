"""Regression: when a live simulation stops on its own (an error, or nobody watching), the app keeps getting the
reason, and the session stays readable until the user ends it.

With a separate worker, the worker used to delete the live-frame row as soon as a session ended, so the error it
had just published was lost and every request answered "live session '<id>' not found".
"""
import os
import tempfile
import time

os.environ.setdefault("TRAFFICSIM_DATA", tempfile.mkdtemp(prefix="tsapi_"))

from fastapi.testclient import TestClient  # noqa: E402

from trafficsim.api import app  # noqa: E402

c = TestClient(app)


def test_live_error_is_reported_not_lost():
    sid = c.post("/api/networks/grid3x3/baseline").json()["id"]
    r = c.post("/api/live", json={"scenario_id": sid, "controller": "external", "duration_min": 10,
                                  "external": {"url": "http://localhost:1/", "name": "Nobody home"}})
    assert r.status_code == 200, r.text
    lid = r.json()["id"]
    seen, t0 = [], time.time()
    while time.time() - t0 < 60:
        f = c.get(f"/api/live/{lid}/frame", params={"after": 0})
        seen.append(f.status_code)
        if f.status_code != 200:
            break
        time.sleep(0.5)
    assert f.status_code == 500 and "Could not start the external controller" in f.json()["detail"], (seen, f.text)
    time.sleep(3)                                     # after the worker has cleaned up its side
    f = c.get(f"/api/live/{lid}/frame", params={"after": 0})
    assert f.status_code == 500 and "Could not start the external controller" in f.json()["detail"], f.text
    info = c.get(f"/api/live/{lid}").json()
    assert info["state"] == "failed" and "Could not start the external controller" in info["error"]
    ctl = c.post(f"/api/live/{lid}/control", json={"action": "pause"})
    assert ctl.status_code == 200 and ctl.json()["state"] == "failed"
    assert c.delete(f"/api/live/{lid}").status_code == 200
    assert c.get(f"/api/live/{lid}").status_code == 404
