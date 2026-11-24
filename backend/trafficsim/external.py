"""External signal controllers: your own algorithm runs as a small web service and Junction asks it, every
few simulated seconds, which green each signal should show next.

Protocol "junction-controller/1" (JSON over HTTP POST to the controller's URL):

  start   sent once when a run begins; lists every controlled signal and its green options. Any 2xx reply.
  decide  sent every `delta_t` seconds with the signals that are free to change (past minimum green and
          not in the middle of a change). Reply {"actions": {"<signal id>": <option index>, ...}}.
          A signal left out, or given its current option, keeps its green.
  end     sent once when the run finishes, with the run's call statistics. Any reply.

Junction, not the controller, applies the safety rules: minimum green, then amber, then all-red before any
new green. A controller can only choose among the signal's own green phases.

Measurements sent per option (raw vehicle counts over `reach_m` metres of road, as SUMO reports them):
  queue         stopped vehicles waiting to use this green
  approaching   moving vehicles on those approaches
  queue_beyond  stopped vehicles on the roads this green leads into
"""
import http.client
import json
import socket
import time
from typing import Optional
from urllib.parse import urlsplit

from pydantic import BaseModel, Field

from . import config

PROTOCOL = "junction-controller/1"
MAX_CONSECUTIVE_FAILURES = 10


class ControllerError(ValueError):
    """The external controller cannot be used; the message is shown to the user."""


class ExternalCfg(BaseModel):
    url: str
    name: str = "External controller"
    timeout_s: float = Field(2.0, gt=0, le=30)
    delta_t: int = Field(5, ge=1, le=60)
    min_green: float = Field(10, ge=5, le=60)
    amber: float = Field(3, ge=2, le=6)
    all_red: float = Field(2, ge=0, le=5)
    reach_m: float = Field(60, ge=10, le=300)


def allowed_hosts() -> set:
    return {h.strip().lower() for h in config.CONTROLLER_HOSTS.split(",") if h.strip()}


def check_url(url: str) -> None:
    """Only http(s) URLs on hosts the operator allowed (JUNCTION_CONTROLLER_HOSTS), so a deployed Junction
    cannot be used to send requests to arbitrary machines."""
    p = urlsplit(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        raise ControllerError("The controller address must start with http:// or https:// and name a host.")
    if p.hostname.lower() not in allowed_hosts():
        raise ControllerError(f"Controllers on '{p.hostname}' are not allowed here. Allowed hosts: "
                              f"{', '.join(sorted(allowed_hosts()))} (set JUNCTION_CONTROLLER_HOSTS to change).")


class Client:
    """One kept-alive HTTP connection to the controller."""

    def __init__(self, url: str, timeout: float):
        check_url(url)
        p = urlsplit(url)
        self.https, self.host, self.port = p.scheme == "https", p.hostname, p.port
        self.path = (p.path or "/") + (f"?{p.query}" if p.query else "")
        self.timeout = timeout
        self.conn = None

    def _connect(self):
        cls = http.client.HTTPSConnection if self.https else http.client.HTTPConnection
        self.conn = cls(self.host, self.port, timeout=self.timeout)
        self.conn.connect()
        self.conn.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)   # small requests go out at once

    def post(self, body: dict) -> dict:
        data = json.dumps(body).encode()
        for attempt in (0, 1):                       # one reconnect if a kept-alive connection was dropped
            try:
                if self.conn is None:
                    self._connect()
                self.conn.request("POST", self.path, body=data, headers={"Content-Type": "application/json"})
                r = self.conn.getresponse()
                raw = r.read()
                if not 200 <= r.status < 300:
                    raise ControllerError(f"The controller answered HTTP {r.status}.")
                return json.loads(raw) if raw.strip() else {}
            except (http.client.HTTPException, ConnectionError, OSError) as e:
                self.close()
                if attempt or isinstance(e, TimeoutError):
                    raise ControllerError(f"No answer from the controller ({type(e).__name__}).") from e
            except json.JSONDecodeError as e:
                raise ControllerError("The controller's answer is not JSON.") from e
        return {}

    def close(self):
        if self.conn is not None:
            try:
                self.conn.close()
            except Exception:  # noqa: BLE001
                pass
        self.conn = None


def _actions(reply: dict, options: dict) -> dict:
    """Validated {signal: option} from a decide reply; anything invalid is dropped (the signal holds)."""
    acts = reply.get("actions") if isinstance(reply, dict) else None
    if not isinstance(acts, dict):
        raise ControllerError('The controller\'s answer has no "actions" object.')
    out = {}
    for tid, k in acts.items():
        if tid in options and isinstance(k, int) and not isinstance(k, bool) and 0 <= k < options[tid]:
            out[tid] = k
    return out


class ExternalController:
    """Drives SignalEnv's safe transitions from an external service's choices."""

    def __init__(self, ls, net_file: str, cfg: dict, run_info: Optional[dict] = None):
        from .rl.env import SignalEnv
        self.cfg = ExternalCfg.model_validate(cfg)
        c = self.cfg
        self.env = SignalEnv(ls, net_file, dict(
            observation=dict(reach_m=c.reach_m, features=["queue", "approaching", "out_queue"]),
            action=dict(delta_t=c.delta_t, min_green=c.min_green, amber=c.amber, all_red=c.all_red),
            reward="pressure"))
        self.client = Client(c.url, c.timeout_s)
        self.stats = dict(calls=0, failures=0, decisions=0, changes=0, ms_total=0.0, ms_max=0.0)
        self.decisions: dict = {}
        self._fails = 0
        env = self.env
        signals = [dict(id=tid, options=[dict(lights=a.phases[g][1],
                                              lanes_in=sorted({i for i, _ in a.mov[g]}),
                                              lanes_out=sorted({o for _, o in a.mov[g]})) for g in a.greens])
                   for tid, a in ((t, env.agents[t]) for t in env.ids)]
        try:
            self.client.post(dict(protocol=PROTOCOL, type="start", run=run_info or {}, signals=signals,
                                  settings=c.model_dump(exclude={"url", "name"})))
        except ControllerError as e:
            raise ControllerError(f"Could not start the external controller at {c.url}: {e}") from e

    def _state(self, tid: str, now: float) -> dict:
        env, a = self.env, self.env.agents[tid]
        opts = []
        for g in a.greens:
            q, ap, out = env._phase_feats(a, g)
            opts.append(dict(queue=int(q), approaching=int(ap), queue_beyond=int(out)))
        return dict(id=tid, current=a.greens.index(a.cur) if a.cur in a.greens else None,
                    green_for_s=round(now - a.since, 1), options=opts)

    def step(self):
        env, ls = self.env, self.env.ls
        env.tick()
        t = ls.simulation.getTime()
        if int(t) % env.delta_t:
            return
        ready = [tid for tid in env.ids if env.ready(tid)]
        if not ready:
            return
        states = [self._state(tid, t) for tid in ready]
        t0 = time.perf_counter()
        self.stats["calls"] += 1
        try:
            reply = self.client.post(dict(protocol=PROTOCOL, type="decide", time_s=t, signals=states))
            acts = _actions(reply, {s["id"]: len(s["options"]) for s in states})
            self._fails = 0
        except ControllerError as e:
            self.stats["failures"] += 1
            self._fails += 1
            if self._fails >= MAX_CONSECUTIVE_FAILURES:
                raise ControllerError(f"The external controller failed {self._fails} times in a row "
                                      f"(last: {e}); the run was stopped.") from e
            return                                   # this time, every signal keeps its green
        finally:
            ms = (time.perf_counter() - t0) * 1000
            self.stats["ms_total"] += ms
            self.stats["ms_max"] = max(self.stats["ms_max"], ms)
        for s in states:
            tid, a = s["id"], env.agents[s["id"]]
            k = acts.get(tid, s["current"] if s["current"] is not None else 0)
            held = a.greens[k] == a.cur
            env.act(tid, k)
            self.stats["decisions"] += 1
            self.stats["changes"] += 0 if held else 1
            self.decisions[tid] = dict(t=t, chosen=k, held=held, kind="queue",
                                       values=[o["queue"] for o in s["options"]],
                                       phases=[a.phases[g][1] for g in a.greens])

    def summary(self) -> dict:
        s = self.stats
        return dict(calls=s["calls"], failures=s["failures"], decisions=s["decisions"], changes=s["changes"],
                    mean_ms=round(s["ms_total"] / s["calls"], 1) if s["calls"] else None, max_ms=round(s["ms_max"], 1))

    def close(self):
        try:
            self.client.post(dict(protocol=PROTOCOL, type="end", stats=self.summary()))
        except ControllerError:
            pass
        self.client.close()


def test(url: str, timeout_s: float = 2.0) -> dict:
    """Send one example decide request (marked "test": true) and check the answer's format."""
    c = Client(url, timeout_s)
    sample = dict(protocol=PROTOCOL, type="decide", test=True, time_s=0.0, signals=[dict(
        id="example", current=0, green_for_s=30.0,
        options=[dict(queue=2, approaching=1, queue_beyond=0), dict(queue=9, approaching=3, queue_beyond=0)])])
    t0 = time.perf_counter()
    try:
        reply = c.post(sample)
        acts = _actions(reply, {"example": 2})
    finally:
        c.close()
    ms = (time.perf_counter() - t0) * 1000
    return dict(ok=True, ms=round(ms, 1), reply=reply,
                note=("Valid answer." if "example" in acts else
                      'Valid format, but it gave no choice for the example signal, so it would keep its green.'))
