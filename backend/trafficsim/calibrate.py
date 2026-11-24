"""Calibrate a scenario's demand to traffic counts (vehicles per road over the demand window).

Steps (SUMO's own tools):
  1. route the network's demand (duarouter) so each trip's roads are known;
  2. trips that use no counted road are kept as they are;
  3. trips over counted roads are rebuilt by routeSampler: it picks routes, from the original ones plus
     random candidates (randomTrips), so the number of vehicles on every counted road matches the count;
  4. the result is checked twice: counts implied by the routes ("in the demand") and counts measured in one
     SUMO run with the scenario's signal plan ("simulated"), because congestion can keep vehicles from
     reaching a road within the hour.
Fit is reported with GEH on hourly flows (GEH < 5 is the usual target for most counted roads).
"""
import csv
import io
import json
import math
import subprocess
import sys
import threading
import time
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path
from xml.sax.saxutils import quoteattr
from typing import List, Optional

import sumolib
from pydantic import BaseModel, Field

from . import build, config, scenario as sc

CAL_DIR = config.WORKSPACE_DIR / "calibrations"
CAL_DIR.mkdir(parents=True, exist_ok=True)
EDGE_COLS = ("edge", "edge_id", "road", "road_id", "id")
COUNT_COLS = ("count", "vehicles", "veh", "volume", "flow")
MAX_CANDIDATES = 3000


class CountRow(BaseModel):
    edge: str
    count: float = Field(ge=0)


class CalibrationError(ValueError):
    """Bad counts or a failed calibration; the message is shown to the user."""


def parse_csv(text: str, net) -> tuple[List[CountRow], List[str]]:
    """Rows with a road id and a count. Unknown roads or bad numbers are reported, not silently dropped."""
    rows = list(csv.reader(io.StringIO(text.strip())))
    if len(rows) < 2:
        raise CalibrationError("The file needs a header row and at least one count.")
    head = [h.strip().lower() for h in rows[0]]
    ei = next((head.index(c) for c in EDGE_COLS if c in head), None)
    ci = next((head.index(c) for c in COUNT_COLS if c in head), None)
    if ei is None or ci is None:
        raise CalibrationError(f"The header needs a road column ({', '.join(EDGE_COLS)}) and a count column "
                               f"({', '.join(COUNT_COLS)}). Found: {', '.join(rows[0])}.")
    out, problems, seen = [], [], set()
    for n, r in enumerate(rows[1:], start=2):
        if len(r) <= max(ei, ci) or not r[ci].strip():
            continue                                  # blank count: road not counted
        edge = r[ei].strip()
        try:
            v = float(r[ci])
        except ValueError:
            problems.append(f"Row {n}: '{r[ci]}' is not a number.")
            continue
        if v < 0:
            problems.append(f"Row {n}: counts cannot be negative.")
        elif not net.hasEdge(edge):
            problems.append(f"Row {n}: road '{edge}' is not in this network.")
        elif not net.getEdge(edge).allows("passenger"):
            problems.append(f"Row {n}: road '{edge}' is closed to cars.")
        elif edge in seen:
            problems.append(f"Row {n}: road '{edge}' is counted twice; the first count is used.")
        else:
            seen.add(edge)
            out.append(CountRow(edge=edge, count=v))
    if not out:
        raise CalibrationError("No usable counts found. " + " ".join(problems[:5]))
    return out, problems


def geh(model_h: float, count_h: float) -> float:
    return math.sqrt(2 * (model_h - count_h) ** 2 / (model_h + count_h)) if model_h + count_h > 0 else 0.0


def _status(d: Path, **kw):
    f = d / "status.json"
    s = json.loads(f.read_text()) if f.exists() else {}
    s.update(kw)
    (d / "status.tmp").write_text(json.dumps(s))
    (d / "status.tmp").replace(f)


def _run(cmd: list, what: str, cwd: Path):
    r = subprocess.run(cmd, capture_output=True, text=True, cwd=cwd, env=config.tool_env())
    if r.returncode != 0:
        tail = (r.stderr or r.stdout).strip().splitlines()[-3:]
        raise CalibrationError(f"{what} failed: {' '.join(tail)[-400:]}")
    return r


def _vehicles(rou: Path):
    """(element, edges list, depart) for every vehicle with a route; plus the vType elements."""
    root = ET.parse(rou).getroot()
    routes = {r.get("id"): r.get("edges").split() for r in root.findall("route")}
    vtypes, vehs = root.findall("vType"), []
    for v in root.findall("vehicle"):
        r = v.find("route")
        if r is not None:
            edges = r.get("edges").split()
        elif v.get("route") in routes:
            edges = routes[v.get("route")]
            ET.SubElement(v, "route", edges=" ".join(edges))      # inline it so the vehicle stands alone
            del v.attrib["route"]
        else:
            continue
        vehs.append((v, edges, float(v.get("depart", 0))))
    return vehs, vtypes


def calibrate(s: sc.Scenario, counts: List[CountRow], d: Path, seed: int = 1):
    _status(d, state="running", step="Building the network", started=time.time())
    work = d / "work"
    work.mkdir(exist_ok=True)
    b = build.build(s.model_copy(update=dict(calibration=None)), work)
    net_file = str(b.net_file)
    begin, end = b.begin, b.end
    counted = {c.edge: c.count for c in counts}
    hours = (end - begin) / 3600.0
    py = sys.executable

    _status(d, step="Routing the original demand")
    orig = work / "orig.rou.xml"
    _run([str(config.BIN / "duarouter"), "-n", net_file, "-r", str(b.demand_file), "-o", str(orig),
          "--ignore-errors", "--no-warnings", "--repair", "--seed", str(seed)], "Routing the demand", work)
    vehs, vtypes = _vehicles(orig)
    keep = [v for v in vehs if not counted.keys() & set(v[1])]
    touching = [v for v in vehs if counted.keys() & set(v[1])]

    _status(d, step="Generating candidate routes")
    rand = work / "random.rou.xml"
    n_rand = max(200, min(MAX_CANDIDATES - len(touching), 2000))
    _run([py, str(config.TOOLS / "randomTrips.py"), "-n", net_file, "-o", str(work / "random.trips.xml"),
          "-r", str(rand), "-b", str(begin), "-e", str(end), "-p", f"{(end - begin) / n_rand:.3f}",
          "--fringe-factor", "10", "--min-distance", "100", "--seed", str(seed), "--vclass", "passenger",
          "--validate"], "Generating candidate routes", work)
    cand_edges = [e for _, e, _ in touching] + [e for _, e, _ in _vehicles(rand)[0]]
    uniq = list(dict.fromkeys(" ".join(e) for e in cand_edges if counted.keys() & set(e)))
    if not uniq:
        raise CalibrationError("No route in this network passes the counted roads.")
    cand = work / "candidates.rou.xml"
    cand.write_text("<routes>\n" + "".join(f'  <route id="r{i}" edges="{e}"/>\n' for i, e in enumerate(uniq))
                    + "</routes>\n")
    reachable = {e for r in uniq for e in r.split()}
    unreachable = sorted(set(counted) - reachable)
    data = work / "counts.dat.xml"
    data.write_text(f'<data>\n  <interval id="counts" begin="{begin}" end="{end}">\n' + "".join(
        f'    <edge id={quoteattr(e)} entered="{v:g}"/>\n' for e, v in counted.items() if e in reachable)
        + "  </interval>\n</data>\n")

    _status(d, step="Fitting routes to the counts")
    sampled = work / "sampled.rou.xml"
    _run([py, str(config.TOOLS / "routeSampler.py"), "-r", str(cand), "-d", str(data), "-o", str(sampled),
          "-b", str(begin), "-e", str(end), "--prefix", "cal", "--seed", str(seed),
          "--optimize", "full"], "Fitting routes to the counts", work)
    new, _ = _vehicles(sampled)

    # merged demand: kept original trips + fitted trips, in departure order
    root = ET.Element("routes")
    for vt in vtypes:
        root.append(vt)
    for v, _, _ in sorted(keep + new, key=lambda x: x[2]):
        root.append(v)
    demand = d / "demand.rou.xml"
    ET.ElementTree(root).write(demand, encoding="unicode")

    in_demand = {e: 0 for e in counted}
    for _, edges, dep in new + keep:
        if begin <= dep <= end:
            for e in set(edges) & counted.keys():
                in_demand[e] += 1

    _status(d, step="Checking the fit in a simulation")
    add = work / "edgedata.add.xml"
    out_edges = work / "measured.xml"
    add.write_text(f'<additional><edgeData id="check" file="{out_edges}" begin="{begin}" end="{end}" '
                   f'excludeEmpty="true"/></additional>\n')
    adds = [str(add)] + ([str(b.tls_additional)] if b.tls_additional else [])
    _run([config.SUMO, "-n", net_file, "-r", str(demand), "-a", ",".join(adds), "--begin", str(begin),
          "--end", str(end), "--seed", str(seed), "--no-step-log", "true", "--no-warnings", "true",
          "--time-to-teleport", "300", "--ignore-route-errors", "true"], "The check simulation", work)
    # a roadside counter sees vehicles that drive onto the road and those that start their trip on it
    measured = {e.get("id"): float(e.get("entered", 0)) + float(e.get("departed", 0))
                for e in ET.parse(out_edges).getroot().iter("edge")}

    rows = []
    for c in counts:
        dem, sim = in_demand.get(c.edge, 0), measured.get(c.edge, 0.0)
        rows.append(dict(edge=c.edge, count=c.count, in_demand=dem, simulated=sim,
                         geh_demand=round(geh(dem / hours, c.count / hours), 2),
                         geh_simulated=round(geh(sim / hours, c.count / hours), 2),
                         reachable=c.edge in reachable))
    good = sum(r["geh_simulated"] < 5 for r in rows)
    report = dict(
        rows=rows, begin=begin, end=end, seed=seed,
        summary=dict(counted_roads=len(rows), geh_under_5=good, share_geh_under_5=round(good / len(rows), 3),
                     target_vehicles=sum(c.count for c in counts), demand_vehicles=sum(in_demand.values()),
                     simulated_vehicles=sum(measured.get(c.edge, 0.0) for c in counts),
                     original_trips=len(vehs), kept_trips=len(keep), replaced_trips=len(touching),
                     fitted_trips=len(new), total_trips=len(keep) + len(new), candidate_routes=len(uniq)),
        warnings=([f"No route reaches {len(unreachable)} counted road(s): {', '.join(unreachable[:5])}."] if unreachable else [])
        + (["The check used fixed-time signals (pressure-based control runs only in simulations)."]
           if s.controller == "max_pressure" else []))
    (d / "report.json").write_text(json.dumps(report, indent=1))
    for f in work.iterdir():                       # intermediate files are large; the report and demand stay
        if f.is_file():
            f.unlink(missing_ok=True)
    _status(d, state="done", step=None, finished=time.time())


class Manager:
    def __init__(self):
        self.lock = threading.Lock()

    def start(self, s: sc.Scenario, counts: List[CountRow], problems: List[str], seed: int = 1) -> dict:
        cid = uuid.uuid4().hex[:10]
        d = CAL_DIR / cid
        d.mkdir(parents=True)
        (d / "meta.json").write_text(json.dumps(dict(id=cid, scenario_id=s.id, network=s.base_network, created=time.time(),
                                                     counts=[c.model_dump() for c in counts], problems=problems, seed=seed)))
        _status(d, state="queued", created=time.time())

        def go():
            try:
                with self.lock:                      # one at a time: routing and fitting are CPU heavy
                    calibrate(s, counts, d, seed)
            except Exception as e:  # noqa: BLE001
                msg = str(e) if isinstance(e, (CalibrationError, build.EditError)) else f"{type(e).__name__}: {e}"
                _status(d, state="failed", error=msg, finished=time.time())

        threading.Thread(target=go, daemon=True).start()
        return self.info(cid)

    def info(self, cid: str) -> dict:
        d = CAL_DIR / cid
        if not (d / "meta.json").exists():
            raise KeyError(f"calibration '{cid}' not found")
        meta = json.loads((d / "meta.json").read_text())
        st = json.loads((d / "status.json").read_text())
        rep = json.loads((d / "report.json").read_text()) if (d / "report.json").exists() else None
        return dict(meta, status=st, report=rep)

    def list(self, scenario_id: Optional[str] = None) -> list:
        out = []
        for d in CAL_DIR.iterdir():
            try:
                i = self.info(d.name)
            except (KeyError, json.JSONDecodeError, FileNotFoundError):
                continue
            if scenario_id is None or i["scenario_id"] == scenario_id:
                i.pop("counts", None)
                out.append(i)
        return sorted(out, key=lambda x: x["created"], reverse=True)


def demand_file(cid: str) -> Optional[Path]:
    f = CAL_DIR / cid / "demand.rou.xml"
    return f if f.exists() else None
