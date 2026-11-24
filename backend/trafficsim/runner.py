"""Run one seed of a scenario and extract KPIs, per-trip outcomes and per-edge statistics.

Measurement rules (see README, "How results are measured"):
- A trip belongs to the demand hour if its *planned* start (depart - departDelay) is in [begin, end].
  Cars that queue before entering the network are therefore still counted.
- Travel time and delay run from the planned start, so time spent queuing to enter is included.
- Trips of vehicles that teleported (read from SUMO's log) are not "completed normally" and are kept
  out of the travel-time averages; they are counted separately.

Runs in a worker process. Fixed-time and actuated control are native SUMO programs (sumo binary);
max-pressure is applied live through libsumo.
"""
import os
import random
import re
import subprocess
import time
import xml.etree.ElementTree as ET
from pathlib import Path

from . import config

TELEPORT_S = 300
JUNCTION_BLOCKER_S = 15   # as in the TUM Ingolstadt model: blocked vehicles may pass after 15 s
MP_MIN_GREEN = 10   # s
MP_DECISION = 5     # s between max-pressure decisions
MP_MAX_WAIT = 90    # s a phase with waiting cars may go unserved before it is forced
MP_AMBER = 3        # s amber for movements losing green
MP_ALL_RED = 2      # s all-red clearance


def _demand_for_seed(job: dict, out: Path) -> str:
    """Route file for this seed. With depart_jitter_s > 0, every trip's start time is shifted by a
    uniform random amount in [-J, +J] (seeded by the run seed, kept inside the demand hour), so seeds
    vary the traffic itself and not only driver behaviour. Both options of a comparison get the same
    shifts for the same seed, so they stay paired."""
    j = float(job.get("depart_jitter_s") or 0)
    if j <= 0:
        return job["demand_file"]
    tree = ET.parse(job["demand_file"])
    root = tree.getroot()
    rng = random.Random(f"depart-{job['seed']}")
    timed, other = [], []
    for el in list(root):
        dep = el.get("depart")
        try:
            t = float(dep)
        except (TypeError, ValueError):
            other.append(el)
            continue
        t = min(max(t + rng.uniform(-j, j), job["begin"]), job["end"])
        el.set("depart", f"{t:.2f}")
        timed.append((t, el))
        root.remove(el)
    for el in other:
        root.remove(el)
    for el in other:                       # vTypes, routes, flows first
        root.append(el)
    for _, el in sorted(timed, key=lambda x: x[0]):   # SUMO needs departures in time order
        root.append(el)
    f = out / "demand.rou.xml"
    tree.write(f)
    return str(f)


def _common_args(job: dict, out: Path) -> list:
    end = job["end"] + config.DRAIN_S
    edge_add = out / "edgedata.add.xml"
    edge_add.write_text(
        f'<additional><edgeData id="run" file="{out / "edges.xml"}" begin="{job["begin"]}" '
        f'end="{end}" excludeEmpty="true" withInternal="false"/></additional>\n')
    adds = [str(edge_add)] + ([job["tls_additional"]] if job.get("tls_additional") else [])
    return ["-n", job["net_file"], "-r", _demand_for_seed(job, out), "-a", ",".join(adds),
            "--begin", str(job["begin"]), "--end", str(end),
            "--scale", str(job["scale"]), "--seed", str(job["seed"]),
            "--step-length", str(config.STEP_LENGTH),
            "--time-to-teleport", str(TELEPORT_S), "--ignore-route-errors", "true",
            "--ignore-junction-blocker", str(JUNCTION_BLOCKER_S),
            "--no-step-log", "true", "--log", str(out / "sumo.log"),
            "--tripinfo-output", str(out / "tripinfo.xml"), "--tripinfo-output.write-unfinished", "true",
            "--statistic-output", str(out / "stats.xml")]


def _run_native(job: dict, out: Path):
    r = subprocess.run([config.SUMO, *_common_args(job, out)], capture_output=True, text=True)
    if r.returncode != 0:
        errs = [ln.strip() for ln in r.stderr.splitlines() if ln.strip().startswith("Error")]
        msg = " ".join(errs) if errs else " ".join(r.stderr.strip().splitlines()[-2:])
        raise RuntimeError("SUMO stopped with an error. " + (msg or f"Exit code {r.returncode}.")[-500:])


def _is_green(state: str) -> bool:
    return any(c in "Gg" for c in state) and "y" not in state


def _run_max_pressure(job: dict, out: Path):
    import libsumo as ls
    ls.start(["sumo", *_common_args(job, out)])
    try:
        ctrl = {}
        for tid in ls.trafficlight.getIDList():
            logic = ls.trafficlight.getAllProgramLogics(tid)[0]
            phases = [(p.duration, p.state) for p in logic.phases]
            greens = [i for i, (_, s) in enumerate(phases) if _is_green(s)]
            # Real plans often have phases mixing green and amber. If a movement is green only in such
            # phases, add them as candidates, or that movement would never be served.
            covered = {k for g in greens for k, ch in enumerate(phases[g][1]) if ch in "Gg"}
            for i, (_, s) in enumerate(phases):
                if i not in greens and any(ch in "Gg" and k not in covered for k, ch in enumerate(s)):
                    greens.append(i)
                    covered |= {k for k, ch in enumerate(s) if ch in "Gg"}
            if len(greens) < 2:
                continue
            links = ls.trafficlight.getControlledLinks(tid)
            movements = {}
            for gi in greens:
                st = phases[gi][1]
                movements[gi] = [(l[0][0], l[0][1]) for i, l in enumerate(links) if l and st[i] in "Gg"]
            ls.trafficlight.setPhase(tid, greens[0])
            ls.trafficlight.setPhaseDuration(tid, 1e6)
            t0 = ls.simulation.getTime()
            program = ls.trafficlight.getProgram(tid)
            ctrl[tid] = dict(phases=phases, greens=greens, mov=movements, cur=greens[0],
                             since=t0, queue=[], until=None, target=None,
                             served={g: t0 for g in greens}, program=program)
        end = job["end"] + config.DRAIN_S
        while ls.simulation.getTime() < end:
            ls.simulationStep()
            now = ls.simulation.getTime()
            halting = {}

            def h(lane):
                if lane not in halting:
                    halting[lane] = ls.lane.getLastStepHaltingNumber(lane)
                return halting[lane]

            for tid, c in ctrl.items():
                if c["until"] is not None:                      # in an amber/all-red transition
                    if now >= c["until"]:
                        if c["queue"]:
                            state, dur = c["queue"].pop(0)
                            ls.trafficlight.setRedYellowGreenState(tid, state)
                            c["until"] = now + dur
                        else:
                            ls.trafficlight.setProgram(tid, c["program"])
                            ls.trafficlight.setPhase(tid, c["target"])
                            ls.trafficlight.setPhaseDuration(tid, 1e6)
                            c.update(cur=c["target"], since=now, until=None, target=None)
                    continue
                c["served"][c["cur"]] = now
                if now - c["since"] < MP_MIN_GREEN or int(now) % MP_DECISION:
                    continue
                pressure = {g: sum(h(i) - h(o) for i, o in c["mov"][g]) for g in c["greens"]}
                # starvation guard: a phase with waiting cars gets green after MP_MAX_WAIT seconds
                starved = [g for g in c["greens"] if g != c["cur"] and now - c["served"][g] > MP_MAX_WAIT
                           and sum(h(i) for i, _ in c["mov"][g]) > 0]
                if starved:
                    best = max(starved, key=lambda g: now - c["served"][g])
                else:
                    best = max(pressure, key=pressure.get)
                    if best == c["cur"] or pressure[best] <= pressure[c["cur"]]:
                        continue
                # Build the transition for this specific pair of phases: amber for movements that lose
                # green, then all-red for them, while movements green in both phases keep going.
                cur_s, tgt_s = c["phases"][c["cur"]][1], c["phases"][best][1]
                keep = [a in "Gg" and b in "Gg" for a, b in zip(cur_s, tgt_s)]
                amber = "".join(a if k else ("y" if a in "Gg" else "r") for a, k in zip(cur_s, keep))
                allred = "".join(a if k else "r" for a, k in zip(cur_s, keep))
                c["target"] = best
                c["queue"] = [(allred, MP_ALL_RED)]
                ls.trafficlight.setRedYellowGreenState(tid, amber)
                c["until"] = now + MP_AMBER
    finally:
        ls.close()


TELEPORT_RE = re.compile(r"Teleporting vehicle '([^']+)'")
# per-trip status codes stored with each seed result
NORMAL, TELEPORTED, UNFINISHED, REMOVED = 0, 1, 2, 3


def teleported_ids(out: Path) -> set:
    log = out / "sumo.log"
    if not log.exists():
        return set()
    with open(log, errors="replace") as f:
        return {m.group(1) for line in f for m in [TELEPORT_RE.search(line)] if m}


def _parse(job: dict, out: Path) -> dict:
    begin, end = job["begin"], job["end"]
    tt, loss, wait, stops = [], [], [], []
    unfinished = removed = late = teleported = 0
    tele = teleported_ids(out)
    trips = {}               # trip id -> [travel time from planned start, delay incl. queue to enter, status]
    for t in ET.parse(out / "tripinfo.xml").getroot().iter("tripinfo"):
        dep = float(t.get("depart"))
        queue = max(0.0, float(t.get("departDelay", 0) or 0))
        planned = dep - queue
        if planned < begin or planned > end:
            continue
        if dep > end:
            late += 1                         # entered after the hour; still counted from now on
        vap = t.get("vaporized") not in (None, "", "end")   # "end" = still running at the end
        arrived = float(t.get("arrival", -1)) >= 0
        if vap:
            removed += 1
            trips[t.get("id")] = [None, None, REMOVED]
            continue
        if not arrived:
            unfinished += 1
            trips[t.get("id")] = [None, None, UNFINISHED]
            continue
        d, l = float(t.get("duration")) + queue, float(t.get("timeLoss")) + queue
        if t.get("id") in tele:
            teleported += 1
            trips[t.get("id")] = [round(d, 1), round(l, 1), TELEPORTED]
            continue
        trips[t.get("id")] = [round(d, 1), round(l, 1), NORMAL]
        tt.append(d)
        loss.append(l)
        wait.append(float(t.get("waitingTime")))
        stops.append(float(t.get("waitingCount")))
    st = ET.parse(out / "stats.xml").getroot()
    tel = st.find("teleports")
    veh = st.find("vehicles")
    mean = lambda v: sum(v) / len(v) if v else None
    kpi = dict(
        mean_travel_time_s=mean(tt), mean_delay_s=mean(loss), mean_waiting_s=mean(wait),
        mean_stops=mean(stops), completed_trips=len(tt), unfinished_trips=unfinished,
        teleports=int(tel.get("total")) if tel is not None else 0, teleported_trips=teleported,
        not_inserted=int(veh.get("waiting", 0)) if veh is not None else 0,
        late_departures=late, removed=removed,
        total_delay_veh_h=sum(loss) / 3600.0)
    edges = {}
    root = ET.parse(out / "edges.xml").getroot()
    for iv in root.iter("interval"):
        for e in iv.iter("edge"):
            entered = float(e.get("entered", 0)) or float(e.get("departed", 0))
            sampled = float(e.get("sampledSeconds", 0))
            edges[e.get("id")] = dict(
                speed_kmh=round(float(e.get("speed", 0)) * 3.6, 2) if sampled else None,
                volume=entered,
                delay_per_veh_s=round(float(e.get("timeLoss", 0)) / entered, 2) if entered else None,
                waiting_s=float(e.get("waitingTime", 0)),
                density=float(e.get("density", 0)) if e.get("density") else None)
    return dict(kpi=kpi, edges=edges, trips=trips, measure_version=2)


def run_seed(job: dict) -> dict:
    """job: net_file, demand_file, tls_additional, begin, end, scale, seed, controller, out_dir."""
    out = Path(job["out_dir"])
    out.mkdir(parents=True, exist_ok=True)
    t0 = time.perf_counter()
    if job["controller"] == "max_pressure":
        _run_max_pressure(job, out)
    else:
        _run_native(job, out)
    res = _parse(job, out)
    res.update(seed=job["seed"], wall_s=round(time.perf_counter() - t0, 2))
    for f in ("tripinfo.xml", "sumo.log", "demand.rou.xml"):          # large; keep edges.xml and stats.xml
        try:
            os.remove(out / f)
        except OSError:
            pass
    return res


if __name__ == "__main__":
    # python -m trafficsim.runner <job.json> <result.json>
    import json
    import sys
    with open(sys.argv[1]) as f:
        _job = json.load(f)
    _res = run_seed(_job)
    with open(sys.argv[2], "w") as f:
        json.dump(_res, f)
