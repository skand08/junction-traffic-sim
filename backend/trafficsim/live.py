"""Live simulation: one SUMO run stepped in its own process, streamed to the browser as frames.

The SUMO process only simulates and measures; the web server holds the latest frame and serves it;
the browser draws it. Nothing shown is invented: every vehicle position, signal state, queue and
number in a frame is read from SUMO at that simulated second.

Frame (sent a few times per wall-clock second):
  t, state, speed                      simulated time, running/paused/finished, pace
  veh  [[id, lon, lat, angle, km/h, type, waiting_s], ...]   vehicles in the network
  edges {edge: [vehicles, halting, mean km/h, waiting_s]}    only edges with vehicles
  tls  {tls: [state string, phase index, seconds to next switch]}
  kpi  running vehicles, mean speed, mean waiting, % halting, throughput per hour, totals
  hist [[t, running, mean km/h, % halting, arrived], ...]    every 30 simulated seconds
  watch details of the road or junction the user has selected (per-lane numbers, signal plan)
"""
import multiprocessing as mp
import random
import threading
import time
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Dict, List, Literal, Optional

from pydantic import BaseModel, Field

from . import config
from .external import ExternalCfg

LIVE_DIR = config.WORKSPACE_DIR / "live"      # working files of live sessions (built network, routes)
LIVE_DRAIN_S = 900                            # simulated time after the demand window for trips to finish

# ---------- configuration (what the user picks) ----------

INTENSITY = {"low": 0.6, "medium": 1.0, "high": 1.4}          # multiplies the scenario's own traffic
PROFILES = ("normal", "morning", "evening")
# vehicle mixes, shares in percent: car, two-wheeler, bus, truck. "data" keeps the network's own types.
MIXES = {
    "data": None,
    "cars": dict(car=100, two_wheeler=0, bus=0, truck=0),
    "mixed": dict(car=70, two_wheeler=15, bus=5, truck=10),
    "two_wheelers": dict(car=40, two_wheeler=50, bus=5, truck=5),
}
# Sizes and performance per type. All use SUMO's "passenger" class, so they may use every lane cars
# may use; lane rules specific to buses or two-wheelers are not modelled.
VTYPES = {
    "car": dict(length="4.5", minGap="2.5", accel="2.6", decel="4.5", maxSpeed="38.9", color="0.35,0.39,0.42"),
    "two_wheeler": dict(length="2.2", minGap="1.0", accel="3.2", decel="5.0", maxSpeed="22.2", color="0.18,0.43,0.71"),
    "bus": dict(length="12.0", minGap="3.0", accel="1.2", decel="4.0", maxSpeed="22.2", color="0.06,0.36,0.27"),
    "truck": dict(length="10.0", minGap="3.0", accel="1.0", decel="4.0", maxSpeed="25.0", color="0.78,0.38,0.16"),
}
TYPE_INDEX = {"car": 0, "two_wheeler": 1, "bus": 2, "truck": 3}


class LiveRoute(BaseModel):
    from_edge: str
    to_edge: str
    per_hour: int = Field(300, ge=10, le=3000)


class LiveConfig(BaseModel):
    scenario_id: str
    controller: Optional[Literal["fixed", "actuated", "max_pressure", "rl", "external"]] = None   # None: the scenario's own
    rl_agent: Optional[str] = None             # trained agent id, with controller "rl"
    external: Optional[ExternalCfg] = None     # with controller "external": your controller's address
    rl_checkpoint: str = "final"
    intensity: Literal["low", "medium", "high"] = "medium"
    profile: Literal["normal", "morning", "evening"] = "normal"
    mix: Literal["data", "cars", "mixed", "two_wheelers"] = "data"
    duration_min: int = Field(30, ge=5, le=60)
    routes: List[LiveRoute] = Field(default_factory=list)
    seed: int = Field(1, ge=1, le=10_000)


def profile_times(n: int, begin: float, dur: float, profile: str) -> List[float]:
    """n departure times in [begin, begin+dur] following the profile: even, an early peak (morning)
    or a late peak (evening). Quantiles of a Beta distribution, so the count is exact and repeatable."""
    if n == 0:
        return []
    from scipy.stats import beta
    a, b = {"normal": (1.0, 1.0), "morning": (2.0, 3.5), "evening": (3.5, 2.0)}[profile]
    return [begin + dur * float(beta.ppf((i + 0.5) / n, a, b)) for i in range(n)]


def live_demand(base_demand: Path, out: Path, cfg: LiveConfig, begin: float, end: float, net) -> Path:
    """Routes for the live run: a share of the network's trips matching the chosen duration, re-timed to
    the chosen profile, with the chosen vehicle mix, plus the user's own entry-to-destination flows."""
    rng = random.Random(f"live-{cfg.seed}")
    tree = ET.parse(base_demand)
    root = tree.getroot()
    trips = [el for el in root if el.tag in ("trip", "vehicle")]
    keep_types = [el for el in root if el.tag == "vType"]
    for el in list(root):
        root.remove(el)
    hour = max(1.0, end - begin)
    dur = cfg.duration_min * 60.0
    share = min(1.0, dur / hour)
    trips.sort(key=lambda el: float(el.get("depart", "0")))
    chosen = [el for el in trips if rng.random() < share]
    times = profile_times(len(chosen), begin, dur, cfg.profile)
    mix = MIXES[cfg.mix]
    for el in keep_types:
        root.append(el)
    if mix is not None:
        for name, attrs in VTYPES.items():
            root.append(ET.Element("vType", dict(id=f"jx_{name}", vClass="passenger", **attrs)))
    # user routes: flows from an entry road to a destination road for the whole window (routed by SUMO)
    for i, r in enumerate(cfg.routes):
        f = ET.Element("flow", {"id": f"user{i}", "from": r.from_edge, "to": r.to_edge, "begin": f"{begin:.0f}",
                                "end": f"{begin + dur:.0f}", "vehsPerHour": str(r.per_hour),
                                "departLane": "best", "departSpeed": "max"})
        if mix is not None:
            f.set("type", "jx_car")
        root.append(f)
    names, weights = (list(mix), list(mix.values())) if mix else ([], [])
    for el, t in zip(chosen, times):
        el.set("depart", f"{t:.2f}")
        if mix is not None:
            el.set("type", f"jx_{rng.choices(names, weights)[0]}")
        root.append(el)
    f = out / "live.rou.xml"
    tree.write(f)
    return f


# ---------- the SUMO process ----------

class LiveError(ValueError):
    """The live setup cannot run; the message is shown to the user."""


def prepare(s, cfg: "LiveConfig", out: Path, rl_model: Optional[str] = None):
    """Build the scenario and the live traffic into `out`. Returns (job for _worker, session meta).
    Raises build.EditError or LiveError. Used by the API and, in queue mode, again by the worker that runs it."""
    import sumolib
    from . import build
    out.mkdir(parents=True, exist_ok=True)
    b = build.build(s, out)
    net = sumolib.net.readNet(str(b.net_file))
    for r in cfg.routes:
        for e in (r.from_edge, r.to_edge):
            if not net.hasEdge(e) or not net.getEdge(e).allows("passenger"):
                raise LiveError(f"Road {e} is not open to cars in this scenario.")
        path, _ = net.getShortestPath(net.getEdge(r.from_edge), net.getEdge(r.to_edge), vClass="passenger")
        if path is None:
            raise LiveError("There is no route for cars between the chosen entry and destination.")
    window_end = b.begin + cfg.duration_min * 60
    routes = live_demand(b.demand_file, out, cfg, b.begin, b.end, net)
    special = cfg.controller in ("rl", "external")
    job = dict(net_file=str(b.net_file), routes=str(routes), tls_additional=str(b.tls_additional) if b.tls_additional else None,
               begin=b.begin, window_end=window_end, stop=window_end + LIVE_DRAIN_S,
               scale=round(INTENSITY[cfg.intensity] * s.demand_scale, 3), seed=cfg.seed,
               controller=cfg.controller if special else s.controller, rl_model=rl_model,
               external=cfg.external.model_dump() if cfg.controller == "external" else None, speed=1.0)
    meta = dict(scenario_name=s.name, network=s.base_network, controller=job["controller"], begin=b.begin,
                window_end=window_end, stop=window_end + LIVE_DRAIN_S, warnings=b.warnings,
                net_mtime=b.net_file.stat().st_mtime, net_file=str(b.net_file))
    return job, meta


def _converter(net_file: str):
    """Vectorised net x/y -> lon/lat, the same mapping the map uses (geometry._projector)."""
    import numpy as np
    import sumolib
    from .geometry import M_PER_DEG_LAT, M_PER_DEG_LON
    net = sumolib.net.readNet(net_file)
    geo = net.hasGeoProj() if hasattr(net, "hasGeoProj") else bool(net._location.get("projParameter", "!") != "!")
    if geo:
        ox, oy = net.getLocationOffset()
        proj = net.getGeoProj()

        def conv(xs, ys):
            lon, lat = proj(np.asarray(xs) - ox, np.asarray(ys) - oy, inverse=True)
            return np.round(lon, 7), np.round(lat, 7)
    else:
        def conv(xs, ys):
            return np.round(np.asarray(xs) / M_PER_DEG_LON, 8), np.round(np.asarray(ys) / M_PER_DEG_LAT, 8)
    return conv, net


def _worker(job: dict, conn):
    """Runs in its own process. Steps SUMO, applies the controller, and sends frames over conn."""
    import libsumo as ls
    from .runner import JUNCTION_BLOCKER_S, TELEPORT_S, PressureController
    try:
        conv, net = _converter(job["net_file"])
        args = ["sumo", "-n", job["net_file"], "-r", job["routes"],
                "--begin", str(job["begin"]), "--end", str(job["stop"]),
                "--scale", str(job["scale"]), "--seed", str(job["seed"]),
                "--step-length", str(config.STEP_LENGTH),
                "--time-to-teleport", str(TELEPORT_S), "--ignore-route-errors", "true",
                "--ignore-junction-blocker", str(JUNCTION_BLOCKER_S),
                "--no-step-log", "true", "--no-warnings", "true"]
        if job.get("tls_additional"):
            args += ["-a", job["tls_additional"]]
        ls.start(args)
    except Exception as e:  # noqa: BLE001
        conn.send(dict(kind="error", error=f"SUMO could not start: {e}"))
        return
    pressure = PressureController(ls, job["net_file"]) if job["controller"] == "max_pressure" else None
    rl = None
    if job["controller"] == "rl":
        from .rl.policy import RLController
        try:
            rl = RLController(ls, job["net_file"], job["rl_model"])
        except Exception as e:  # noqa: BLE001
            conn.send(dict(kind="error", error=str(e)))
            ls.close()
            return
    if job["controller"] == "external":
        from .external import ExternalController
        try:
            rl = ExternalController(ls, job["net_file"], job["external"], run_info=dict(live=True, seed=job["seed"]))
        except Exception as e:  # noqa: BLE001
            conn.send(dict(kind="error", error=str(e)))
            ls.close()
            return
    tls_ids = list(ls.trafficlight.getIDList())
    state, speed, watch = "running", float(job.get("speed", 1.0)), None
    seq, hist, arrivals = 0, [], []
    arrived = departed = teleports = 0
    frame_every = 0.25
    last_frame = 0.0
    wall0, sim0 = time.monotonic(), ls.simulation.getTime()

    def frame():
        nonlocal seq
        seq += 1
        t = ls.simulation.getTime()
        ids = ls.vehicle.getIDList()
        xs, ys, veh, edges = [], [], [], {}
        speeds, halted, waits = 0.0, 0, 0.0
        for v in ids:
            x, y = ls.vehicle.getPosition(v)
            xs.append(x); ys.append(y)
            sp = ls.vehicle.getSpeed(v)
            w = ls.vehicle.getAccumulatedWaitingTime(v)
            road = ls.vehicle.getRoadID(v)
            tp = ls.vehicle.getTypeID(v)
            veh.append([v, 0, 0, round(ls.vehicle.getAngle(v), 1), round(sp * 3.6, 1),
                        TYPE_INDEX.get(tp[3:], 0) if tp.startswith("jx_") else (2 if "bus" in tp else 0), round(w)])
            speeds += sp
            waits += w
            if sp < 0.1:
                halted += 1
            if not road.startswith(":"):
                e = edges.setdefault(road, [0, 0, 0.0, 0.0])
                e[0] += 1
                e[1] += sp < 0.1
                e[2] += sp * 3.6
                e[3] += w
        if veh:
            lon, lat = conv(xs, ys)
            for row, a, b in zip(veh, lon.tolist(), lat.tolist()):
                row[1], row[2] = a, b
        for e in edges.values():
            e[2] = round(e[2] / e[0], 1)
            e[3] = round(e[3])
        tls = {}
        for tid in tls_ids:
            nxt = ls.trafficlight.getNextSwitch(tid) - t
            tls[tid] = [ls.trafficlight.getRedYellowGreenState(tid), ls.trafficlight.getPhase(tid),
                        round(nxt) if nxt < 3600 else None]
        n = len(ids)
        recent = sum(c for tt, c in arrivals if tt > t - 300)
        span = min(300.0, max(1.0, t - job["begin"]))
        kpi = dict(running=n, mean_speed_kmh=round(speeds / n * 3.6, 1) if n else 0.0,
                   mean_wait_s=round(waits / n, 1) if n else 0.0,
                   halting_pct=round(100 * halted / n, 1) if n else 0.0,
                   throughput_per_h=round(recent * 3600 / span), arrived=arrived, departed=departed,
                   teleports=teleports, waiting_to_enter=len(ls.simulation.getPendingVehicles()))
        return dict(kind="frame", seq=seq, t=t, state=state, speed=speed, veh=veh, edges=edges, tls=tls,
                    kpi=kpi, hist=hist, watch=_watch(ls, watch, t, rl))

    try:
        conn.send(frame())
        while True:
            # commands from the server
            while conn.poll():
                cmd = conn.recv()
                a = cmd.get("action")
                if a == "stop":
                    return
                if a == "pause" and state == "running":
                    state = "paused"
                elif a == "resume" and state == "paused":
                    state, wall0, sim0 = "running", time.monotonic(), ls.simulation.getTime()
                elif a == "speed":
                    speed, wall0, sim0 = float(cmd["speed"]), time.monotonic(), ls.simulation.getTime()
                elif a == "watch":
                    watch = cmd.get("watch")
                conn.send(frame())
                last_frame = time.monotonic()
            if state != "running":
                time.sleep(0.05)
                continue
            # pace: `speed` simulated seconds per wall second (0 = as fast as possible)
            if speed > 0:
                ahead = (ls.simulation.getTime() - sim0) - speed * (time.monotonic() - wall0)
                if ahead > 0:
                    time.sleep(min(ahead / speed, 0.05))
                    if time.monotonic() - last_frame >= frame_every:
                        conn.send(frame()); last_frame = time.monotonic()
                    continue
            ls.simulationStep()
            if pressure:
                pressure.step()
            if rl:
                rl.step()
            t = ls.simulation.getTime()
            a_now = ls.simulation.getArrivedNumber()
            arrived += a_now
            departed += ls.simulation.getDepartedNumber()
            teleports += ls.simulation.getStartingTeleportNumber()
            if a_now:
                arrivals.append((t, a_now))
                if len(arrivals) > 2000:
                    arrivals[:] = [x for x in arrivals if x[0] > t - 300]
            if int(t) % 30 == 0:
                ids = ls.vehicle.getIDList()
                n = len(ids)
                sp = [ls.vehicle.getSpeed(v) for v in ids]
                hist.append([t, n, round(sum(sp) / n * 3.6, 1) if n else 0.0,
                             round(100 * sum(1 for s in sp if s < 0.1) / n, 1) if n else 0.0, arrived])
            done = t >= job["stop"] or (t >= job["window_end"] and ls.simulation.getMinExpectedNumber() == 0)
            if done:
                state = "finished"
                conn.send(frame()); last_frame = time.monotonic()
                continue
            if time.monotonic() - last_frame >= frame_every:
                conn.send(frame()); last_frame = time.monotonic()
    except (EOFError, BrokenPipeError):
        return
    except Exception as e:  # noqa: BLE001
        try:
            conn.send(dict(kind="error", error=f"The simulation stopped: {e}"))
        except Exception:  # noqa: BLE001
            pass
    finally:
        if rl is not None and hasattr(rl, "close"):
            rl.close()                       # tells an external controller the run ended
        try:
            ls.close()
        except Exception:  # noqa: BLE001
            pass


def _watch(ls, watch: Optional[dict], t: float, rl=None) -> Optional[dict]:
    """Details for the selected road or signal, read from SUMO for this frame."""
    if not watch:
        return None
    try:
        if watch.get("edge"):
            e = watch["edge"]
            lanes = []
            for i in range(ls.edge.getLaneNumber(e)):
                ln = f"{e}_{i}"
                lanes.append(dict(index=i, vehicles=ls.lane.getLastStepVehicleNumber(ln),
                                  halting=ls.lane.getLastStepHaltingNumber(ln),
                                  speed_kmh=round(ls.lane.getLastStepMeanSpeed(ln) * 3.6, 1),
                                  limit_kmh=round(ls.lane.getMaxSpeed(ln) * 3.6),
                                  occupancy_pct=round(ls.lane.getLastStepOccupancy(ln) * 100, 1),
                                  width_m=round(ls.lane.getWidth(ln), 2), allowed=ls.lane.getAllowed(ln)))
            return dict(edge=e, lanes=lanes, travel_time_s=round(ls.edge.getTraveltime(e), 1))
        if watch.get("tls"):
            tid = watch["tls"]
            logic = ls.trafficlight.getAllProgramLogics(tid)
            prog = ls.trafficlight.getProgram(tid)
            cur = next((lg for lg in logic if lg.programID == prog), logic[0] if logic else None)
            links = ls.trafficlight.getControlledLinks(tid)
            state = ls.trafficlight.getRedYellowGreenState(tid)
            approaches = {}
            for i, lk in enumerate(links):
                if not lk:
                    continue
                inl = lk[0][0]
                a = approaches.setdefault(inl, dict(lane=inl, edge=inl.rsplit("_", 1)[0], states="",
                                                    halting=ls.lane.getLastStepHaltingNumber(inl),
                                                    vehicles=ls.lane.getLastStepVehicleNumber(inl)))
                a["states"] += state[i] if i < len(state) else "?"
            nxt = ls.trafficlight.getNextSwitch(tid) - t
            return dict(tls=tid, state=state, phase=ls.trafficlight.getPhase(tid),
                        next_switch_s=round(nxt) if nxt < 3600 else None,   # pressure control holds phases open-ended
                        phases=[dict(duration=p.duration, state=p.state) for p in cur.phases] if cur else [],
                        approaches=list(approaches.values()),
                        agent=(rl.decisions.get(tid) if rl else None))
    except Exception as e:  # noqa: BLE001
        return dict(error=str(e))
    return None


# ---------- sessions, held by the web server ----------

class Session:
    def __init__(self, sid: str, cfg: LiveConfig, job: dict, meta: dict):
        self.id, self.cfg, self.job, self.meta = sid, cfg, job, meta
        self.frame: Optional[dict] = None
        self.error: Optional[str] = None
        self.cond = threading.Condition()
        self.proc = None
        self.conn = None
        self.lock = threading.Lock()
        self.run = 0                    # counts starts, so the browser can tell a reset from a frame gap

    def start(self):
        self.run += 1
        ctx = mp.get_context("spawn")
        parent, child = ctx.Pipe()
        self.conn, self.frame, self.error = parent, None, None
        self.proc = ctx.Process(target=_worker, args=(self.job, child), daemon=True)
        self.proc.start()
        child.close()
        threading.Thread(target=self._reader, args=(parent, self.proc), daemon=True).start()

    def _reader(self, conn, proc):
        while True:
            try:
                msg = conn.recv()
            except (EOFError, OSError):
                break
            with self.cond:
                if proc is not self.proc:          # an old process after a reset
                    break
                if msg.get("kind") == "error":
                    self.error = msg["error"]
                else:
                    self.frame = msg
                self.cond.notify_all()

    def send(self, cmd: dict):
        with self.lock:
            try:
                self.conn.send(cmd)
            except (OSError, BrokenPipeError):
                pass

    def stop(self):
        if self.proc and self.proc.is_alive():
            self.send(dict(action="stop"))
            self.proc.join(timeout=3)
            if self.proc.is_alive():
                self.proc.terminate()

    def reset(self):
        self.stop()
        self.start()

    def wait_frame(self, after: int, timeout: float = 1.0) -> Optional[dict]:
        with self.cond:
            if not (self.frame and self.frame["seq"] > after) and not self.error:
                self.cond.wait(timeout)
            return self.frame


class LiveManager:
    """At most MAX sessions at a time; starting another stops the oldest."""
    MAX = 2

    def __init__(self):
        self.sessions: Dict[str, Session] = {}
        self.lock = threading.Lock()

    def create(self, cfg: LiveConfig, job: dict, meta: dict, sid: Optional[str] = None) -> Session:
        s = Session(sid or uuid.uuid4().hex[:10], cfg, job, meta)
        with self.lock:
            while len(self.sessions) >= self.MAX:
                old = next(iter(self.sessions))
                self.sessions.pop(old).stop()
            self.sessions[s.id] = s
        s.start()
        return s

    def get(self, sid: str) -> Session:
        if sid not in self.sessions:
            raise KeyError(f"live session '{sid}' not found")
        return self.sessions[sid]

    def remove(self, sid: str):
        with self.lock:
            s = self.sessions.pop(sid, None)
        if s:
            s.stop()

    def stop_all(self):
        for sid in list(self.sessions):
            self.remove(sid)
