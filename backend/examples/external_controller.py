"""Example external signal controller for Junction ("junction-controller/1" protocol).

Policy: longest queue first. Each time Junction asks, every free signal switches to the green with the most
stopped vehicles, unless the current green's queue is within `--margin` vehicles of it (so lights do not
flip-flop). Replace `choose()` with your own algorithm, trained model, or a call into another system.

Run:   python external_controller.py --port 9000
Then in Junction choose "External controller" and enter http://localhost:9000/
Only the Python standard library is needed.
"""
import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MARGIN = 2


def choose(signal: dict) -> int:
    """signal = {"id", "current", "green_for_s", "options": [{"queue", "approaching", "queue_beyond"}, ...]}
    Return the index of the option (green) to show next."""
    opts = signal["options"]
    best = max(range(len(opts)), key=lambda k: opts[k]["queue"] - 0.5 * opts[k]["queue_beyond"])
    cur = signal["current"]
    if cur is not None and opts[best]["queue"] - opts[cur]["queue"] <= MARGIN:
        return cur
    return best


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"          # keep the connection open between requests: much faster
    disable_nagle_algorithm = True         # send each small reply at once instead of waiting ~40 ms

    def do_POST(self):
        msg = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        if msg.get("type") == "decide":
            reply = {"actions": {s["id"]: choose(s) for s in msg.get("signals", [])}}
        elif msg.get("type") == "start":
            print(f"run started: {len(msg.get('signals', []))} signals, settings {msg.get('settings')}", flush=True)
            reply = {"ok": True}
        else:                                # "end"
            print(f"run ended: {msg.get('stats')}", flush=True)
            reply = {"ok": True}
        body = json.dumps(reply).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):          # quiet: one line per decision would be too much
        pass


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=9000)
    ap.add_argument("--margin", type=int, default=MARGIN)
    a = ap.parse_args()
    MARGIN = a.margin
    print(f"Junction example controller on http://localhost:{a.port}/", flush=True)
    ThreadingHTTPServer(("127.0.0.1", a.port), Handler).serve_forever()
