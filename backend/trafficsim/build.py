"""Turn a scenario into simulation inputs: edited network + signal additional file.

Network edits are applied as netconvert plain-XML patches on the base network:
  set_lanes / set_speed / close_road -> edge patch (numLanes / speed / disallow="all")
  ban_turn                           -> connection patch (<delete from to>)
  set_lane_width / set_road_type     -> edge patch (width / speed + priority)
  add_signal / remove_signal         -> node patch (type="traffic_light" / "priority")
Built networks are cached by a hash of (base network, network edits).
Signal edits and the controller choice only produce an additional file (no rebuild).
"""
import hashlib
import json
import subprocess
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path
from typing import List
from xml.sax.saxutils import quoteattr

from . import catalog, config
from .scenario import NETWORK_EDITS, ROAD_TYPES, Scenario
import sumolib

BUILD_DIR = config.WORKSPACE_DIR / "builds"
BUILD_DIR.mkdir(parents=True, exist_ok=True)


class EditError(ValueError):
    """An edit that cannot be applied; the message is shown to the user."""


@dataclass
class Build:
    net_file: Path
    demand_file: Path
    begin: int
    end: int
    tls_additional: Path | None
    warnings: List[str] = field(default_factory=list)
    unroutable_trips: int = 0
    total_trips: int = 0


def _green(state: str) -> bool:
    return any(c in "Gg" for c in state) and "y" not in state.lower().replace("g", "")


def _validate_network_edits(s: Scenario, net) -> None:
    signal_now: dict = {}
    for e in s.edits:
        if e.type in ("set_lanes", "set_speed", "close_road"):
            if not net.hasEdge(e.edge):
                raise EditError(f"Road '{e.edge}' does not exist in this network.")
        if e.type == "ban_turn":
            if not (net.hasEdge(e.from_edge) and net.hasEdge(e.to_edge)):
                raise EditError(f"Turn {e.from_edge} → {e.to_edge}: road not found.")
            if net.getEdge(e.to_edge) not in net.getEdge(e.from_edge).getOutgoing():
                raise EditError(f"There is no turn from '{e.from_edge}' to '{e.to_edge}' to ban.")
        if e.type in ("set_lane_width", "set_road_type") and not net.hasEdge(e.edge):
            raise EditError(f"Road '{e.edge}' does not exist in this network.")
        if e.type in ("add_signal", "remove_signal"):
            if not net.hasNode(e.node):
                raise EditError(f"Junction '{e.node}' does not exist in this network.")
            node = net.getNode(e.node)
            # follow earlier edits in this scenario: a removed signal can be put back, and the reverse
            is_tl = signal_now.get(e.node, node.getType().startswith("traffic_light"))
            if e.type == "remove_signal" and not is_tl:
                raise EditError(f"Junction '{e.node}' has no signal to remove.")
            if e.type == "add_signal":
                if is_tl:
                    raise EditError(f"Junction '{e.node}' already has a signal.")
                car_in = [x for x in node.getIncoming() if x.allows("passenger")]
                if len(car_in) < 2:
                    raise EditError("A signal needs at least two roads coming into the junction; "
                                    "this one has " + str(len(car_in)) + ".")
            signal_now[e.node] = e.type == "add_signal"
    closed = [e.edge for e in s.edits if e.type == "close_road"]
    for e in s.edits:
        if e.type in ("set_lanes", "set_speed") and e.edge in closed:
            raise EditError(f"Road '{e.edge}' is closed; reopen it before changing lanes or speed.")


def _build_network(s: Scenario, base_dir: Path) -> tuple[Path, List[str]]:
    net_edits = [e for e in s.edits if e.type in NETWORK_EDITS]
    base_net = base_dir / "net.net.xml"
    if not net_edits:
        return base_net, []
    key = hashlib.sha1(s.network_key().encode()).hexdigest()[:16]
    out_dir = BUILD_DIR / key
    out_net = out_dir / "net.net.xml"
    warn_f = out_dir / "warnings.json"
    if out_net.exists() and warn_f.exists():
        return out_net, json.loads(warn_f.read_text())
    out_dir.mkdir(parents=True, exist_ok=True)

    base = sumolib.net.readNet(str(base_net))
    edge_attrs: dict = {}
    lane_children: dict = {}
    for e in net_edits:
        if e.type == "set_lanes":
            # 'lanes' means car lanes; keep sidewalk/bike lanes (lowest indices in SUMO) as they are
            lanes = base.getEdge(e.edge).getLanes()
            noncar = [ln for ln in lanes if not ln.allows("passenger")]
            car = [ln for ln in lanes if ln.allows("passenger")]
            template = " ".join(sorted(car[0].getPermissions())) if car else "passenger"
            perms = [" ".join(sorted(ln.getPermissions())) for ln in noncar] + [template] * e.lanes
            edge_attrs.setdefault(e.edge, {})["numLanes"] = str(len(perms))
            lane_children[e.edge] = perms
        elif e.type == "set_speed":
            edge_attrs.setdefault(e.edge, {})["speed"] = f"{e.speed_kmh / 3.6:.2f}"
        elif e.type == "close_road":
            edge_attrs.setdefault(e.edge, {})["disallow"] = "all"
        elif e.type == "set_lane_width":
            edge_attrs.setdefault(e.edge, {})["width"] = f"{e.width_m:.2f}"
        elif e.type == "set_road_type":
            rt = ROAD_TYPES[e.road_type]
            a = edge_attrs.setdefault(e.edge, {})
            a["speed"] = f"{rt['speed_kmh'] / 3.6:.2f}"
            a["priority"] = str(rt["priority"])
    node_types = {e.node: ("traffic_light" if e.type == "add_signal" else "priority")
                  for e in net_edits if e.type in ("add_signal", "remove_signal")}   # last edit per junction wins
    cmd = [config.NETCONVERT, "-s", str(base_net), "-o", str(out_net), "--no-warnings"]
    if node_types:
        nf = out_dir / "patch.nod.xml"
        nf.write_text("<nodes>\n" + "".join(
            f'  <node id={quoteattr(n)} type="{t}"' + (' tlType="static"' if t == "traffic_light" else "") + "/>\n"
            for n, t in node_types.items()) + "</nodes>\n")
        cmd += ["-n", str(nf)]
    if edge_attrs:
        ef = out_dir / "patch.edg.xml"
        parts = ["<edges>\n"]
        for eid, a in edge_attrs.items():
            attrs = " ".join(f'{k}="{v}"' for k, v in a.items())
            kids = lane_children.get(eid)
            if kids and "disallow" not in a:
                parts.append(f"  <edge id={quoteattr(eid)} {attrs}>\n" + "".join(
                    f'    <lane index="{i}" allow={quoteattr(p)}/>\n' for i, p in enumerate(kids)) + "  </edge>\n")
            else:
                parts.append(f"  <edge id={quoteattr(eid)} {attrs}/>\n")
        ef.write_text("".join(parts) + "</edges>\n")
        cmd += ["-e", str(ef)]
    bans = [e for e in net_edits if e.type == "ban_turn"]
    if bans:
        cf = out_dir / "patch.con.xml"
        cf.write_text("<connections>\n" + "".join(
            f"  <delete from={quoteattr(b.from_edge)} to={quoteattr(b.to_edge)}/>\n" for b in bans)
            + "</connections>\n")
        cmd += ["-x", str(cf)]
    r = subprocess.run(cmd, capture_output=True, text=True, env=config.tool_env())
    if r.returncode != 0 or not out_net.exists():
        raise EditError("The network could not be rebuilt with these changes: " + r.stderr.strip()[-400:])

    warnings = []
    a = sumolib.net.readNet(str(base_net), withPrograms=True)
    b = sumolib.net.readNet(str(out_net), withPrograms=True)
    removed = {e.node for e in net_edits if e.type == "remove_signal"}
    for t in a.getTrafficLights():
        if t.getID() not in b._id2tls:
            if t.getID() not in removed:
                warnings.append(f"Signal {t.getID()} was removed by these changes.")
            continue
        pa = [p.state for p in next(iter(t.getPrograms().values())).getPhases()]
        pb = [p.state for p in next(iter(b.getTLS(t.getID()).getPrograms().values())).getPhases()]
        if pa != pb:
            warnings.append(f"Signal {t.getID()}: lanes or turns changed, so its signal plan was "
                            f"regenerated (default timings, {len(pb)} phases).")
    for nid in node_types:
        if node_types[nid] == "traffic_light" and nid in b._id2tls:
            n = len(next(iter(b.getTLS(nid).getPrograms().values())).getPhases())
            warnings.append(f"New signal at junction {nid}: SUMO generated a default plan ({n} phases). "
                            "You can retime it.")
    warn_f.write_text(json.dumps(warnings))
    return out_net, warnings


def _check_routes(net_file: Path, demand_file: Path) -> tuple[int, int]:
    """Count trips whose origin and destination are no longer connected for cars."""
    net = sumolib.net.readNet(str(net_file))
    root = ET.parse(demand_file).getroot()
    pairs = {}
    total = 0
    for t in root.iter("trip"):
        total += 1
        pairs[(t.get("from"), t.get("to"))] = pairs.get((t.get("from"), t.get("to")), 0) + 1
    for v in root.iter("vehicle"):
        r = v.find("route")
        if r is not None:
            ed = r.get("edges").split()
            total += 1
            pairs[(ed[0], ed[-1])] = pairs.get((ed[0], ed[-1]), 0) + 1
    bad = 0
    for (f, t), n in pairs.items():
        if not (net.hasEdge(f) and net.hasEdge(t)):
            bad += n
            continue
        fe, te = net.getEdge(f), net.getEdge(t)
        if not (fe.allows("passenger") and te.allows("passenger")):
            bad += n
            continue
        path, _ = net.getShortestPath(fe, te, vClass="passenger")
        if path is None:
            bad += n
    return bad, total


def _num(x: float) -> str:
    """Seconds to 0.1 s, without trailing zeros (durations were rounded to whole seconds before)."""
    return f"{round(float(x), 1):g}"


def _tls_additional(s: Scenario, net_file: Path, out_dir: Path, warnings: List[str]) -> Path | None:
    net = sumolib.net.readNet(str(net_file), withPrograms=True)
    progs, offsets = {}, {}
    for t in net.getTrafficLights():
        pid, prog = next(iter(t.getPrograms().items()))
        progs[t.getID()] = [(p.duration, p.state) for p in prog.getPhases()]
        offsets[t.getID()] = float(getattr(prog, "_offset", 0) or 0)   # keep coordination between signals
    retimes = {e.tls: e.durations for e in s.edits if e.type == "retime_signal"}
    for tid, durs in list(retimes.items()):
        if tid not in progs:
            warnings.append(f"Signal {tid} no longer exists; its retiming was skipped.")
            retimes.pop(tid)
        elif len(durs) != len(progs[tid]):
            warnings.append(f"Signal {tid}: the plan now has {len(progs[tid])} phases (it was regenerated), "
                            f"so the retiming with {len(durs)} phases was skipped.")
            retimes.pop(tid)
    if s.controller == "fixed" and not retimes:
        return None
    if s.controller == "max_pressure":
        return None   # controlled live through TraCI in the runner
    lines = ["<additional>"]
    for tid, phases in progs.items():
        if s.controller == "fixed" and tid not in retimes:
            continue
        durs = retimes.get(tid, [d for d, _ in phases])
        kind = "actuated" if s.controller == "actuated" else "static"
        lines.append(f'  <tlLogic id={quoteattr(tid)} type="{kind}" programID="scenario" offset="{_num(offsets[tid])}">')
        for d, (_, st) in zip(durs, phases):
            d = max(1.0, float(d))
            if kind == "actuated" and _green(st):
                lines.append(f'    <phase duration="{_num(d)}" minDur="{_num(max(5, 0.3 * d))}" '
                             f'maxDur="{_num(max(2 * d, d + 20))}" state="{st}"/>')
            else:
                lines.append(f'    <phase duration="{_num(d)}" state="{st}"/>')
        lines.append("  </tlLogic>")
    lines.append("</additional>")
    out_dir.mkdir(parents=True, exist_ok=True)
    f = out_dir / "signals.add.xml"
    f.write_text("\n".join(lines) + "\n")
    return f


def build(s: Scenario, out_dir: Path) -> Build:
    base_dir = catalog.ensure_network(s.base_network)
    m = catalog.meta(s.base_network)
    base = sumolib.net.readNet(str(base_dir / "net.net.xml"))
    _validate_network_edits(s, base)
    net_file, warnings = _build_network(s, base_dir)
    warnings = list(warnings)
    demand = base_dir / "demand.rou.xml"
    bad, total = (0, m.get("trips", 0))
    if any(e.type in ("close_road", "ban_turn") for e in s.edits):
        bad, total = _check_routes(net_file, demand)
        if total and bad / total > 0.2:
            raise EditError(f"These changes cut off {bad} of {total} trips ({bad / total:.0%}) from their "
                            "destinations. Reopen a road or remove a turn ban.")
        if bad:
            warnings.append(f"{bad} of {total} trips can no longer reach their destination and will be skipped.")
    tls_add = _tls_additional(s, net_file, out_dir, warnings)
    return Build(net_file=net_file, demand_file=demand, begin=m["begin"], end=m["end"],
                 tls_additional=tls_add, warnings=warnings, unroutable_trips=bad, total_trips=total)
