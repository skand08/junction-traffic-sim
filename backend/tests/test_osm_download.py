"""OpenStreetMap download: a hung or busy Overpass server must not use up the request; the next server is tried
within a time budget that fits Vercel's 300 s limit, and a failure says the servers did not answer."""
import http.server
import os
import tempfile
import threading
import time
from pathlib import Path

import pytest

os.environ.setdefault("TRAFFICSIM_DATA", tempfile.mkdtemp(prefix="tsapi_"))

from trafficsim import importer  # noqa: E402

OSM = (b'<?xml version="1.0"?><osm version="0.6"><node id="1" lat="18.53" lon="73.853"/>'
       b'<node id="2" lat="18.531" lon="73.854"/><way id="9"><nd ref="1"/><nd ref="2"/>'
       b'<tag k="highway" v="residential"/></way></osm>')


def _server(kind):
    class H(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", 0)))
            if kind == "hang":
                time.sleep(5)
                return
            if kind == "busy":
                self.send_response(504); self.end_headers(); return
            self.send_response(200); self.end_headers(); self.wfile.write(OSM)

        def log_message(self, *a):
            pass
    s = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    return s, f"http://127.0.0.1:{s.server_address[1]}/api/interpreter"


@pytest.fixture
def servers():
    made = {k: _server(k) for k in ("hang", "busy", "ok")}
    yield {k: u for k, (_, u) in made.items()}
    for s, _ in made.values():
        s.shutdown()


def test_falls_through_hung_and_busy_servers(servers, monkeypatch, tmp_path):
    monkeypatch.setattr(importer, "OVERPASS_URLS", [servers["hang"], servers["busy"], servers["ok"]])
    monkeypatch.setattr(importer, "OVERPASS_TIMEOUT_S", 1)
    monkeypatch.setattr(importer, "BUSY_WAITS", (0,))
    t = time.time()
    f = importer.fetch_osm_bbox([73.853, 18.530, 73.856, 18.5325], tmp_path / "a.osm")
    assert b"<way" in Path(f).read_bytes() and time.time() - t < 4


def test_stops_within_the_budget_and_says_why(servers, monkeypatch, tmp_path):
    monkeypatch.setattr(importer, "OVERPASS_URLS", [servers["hang"]] * 5)
    monkeypatch.setattr(importer, "OVERPASS_TIMEOUT_S", 1)
    monkeypatch.setattr(importer, "OVERPASS_BUDGET_S", 2.5)
    t = time.time()
    with pytest.raises(importer.ImportError_) as e:
        importer.fetch_osm_bbox([73.853, 18.530, 73.856, 18.5325], tmp_path / "a.osm")
    assert time.time() - t < 4.5
    assert "did not answer in time" in str(e.value) and "internet connection" not in str(e.value)
