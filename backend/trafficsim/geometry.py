"""Export a SUMO network as GeoJSON (lon/lat) for the map.

Georeferenced networks use their own projection. Synthetic networks have none, so they are
placed at a fixed fake origin (0, 0) with metres mapped to degrees; the UI hides the basemap.
"""
import math
from functools import lru_cache

from . import config  # noqa: F401  (sets SUMO_HOME / sys.path)
import sumolib

M_PER_DEG_LAT = 110_540.0
M_PER_DEG_LON = 111_320.0


def _projector(net):
    loc = net.getLocationOffset()
    geo = net.hasGeoProj() if hasattr(net, "hasGeoProj") else bool(net._location.get("projParameter", "!") != "!")
    if geo:
        return (lambda x, y: net.convertXY2LonLat(x, y)), True
    ox, oy = 0.0, 0.0

    def fake(x, y):
        return ((x - ox) / M_PER_DEG_LON, (y - oy) / M_PER_DEG_LAT)
    return fake, False


@lru_cache(maxsize=32)
def network_geojson(net_file: str, mtime: float) -> dict:
    """mtime is part of the cache key so a rebuilt network is re-read."""
    net = sumolib.net.readNet(net_file, withPrograms=True)
    proj, geo = _projector(net)
    programs = {t.getID() for t in net.getTrafficLights()}
    features = []
    for e in net.getEdges(withInternal=False):
        if e.getFunction() == "internal":
            continue
        coords = [list(proj(x, y)) for x, y in e.getShape()]
        car_lanes = sum(1 for ln in e.getLanes() if ln.allows("passenger"))
        features.append(dict(
            type="Feature",
            geometry=dict(type="LineString", coordinates=coords),
            properties=dict(
                kind="edge", id=e.getID(), name=e.getName() or "", lanes=car_lanes,
                total_lanes=e.getLaneNumber(),
                speed_kmh=round(e.getSpeed() * 3.6, 1), length_m=round(e.getLength(), 1),
                road_type=(e.getType() or "").split(".")[-1], from_node=e.getFromNode().getID(),
                to_node=e.getToNode().getID(), car_allowed=car_lanes > 0,
                priority=e.getPriority(),
                lane_width_m=round(max((ln.getWidth() for ln in e.getLanes() if ln.allows("passenger")), default=0), 2))))
    for n in net.getNodes():
        if n.getType() not in ("traffic_light", "traffic_light_right_on_red", "traffic_light_unregulated"):
            # an unsignalled junction where a signal could go: two or more roads in for cars
            car_in = [e for e in n.getIncoming() if any(ln.allows("passenger") for ln in e.getLanes())]
            if len(car_in) >= 2 and n.getType() not in ("dead_end", "internal", "rail_crossing", "rail_signal"):
                x, y = n.getCoord()
                features.append(dict(
                    type="Feature", geometry=dict(type="Point", coordinates=list(proj(x, y))),
                    properties=dict(kind="junction", id=n.getID(), control=n.getType(),
                                    incoming=[e.getID() for e in n.getIncoming()],
                                    outgoing=[e.getID() for e in n.getOutgoing()])))
            continue
        x, y = n.getCoord()
        tls_ids = {c.getTLSID() for c in n.getConnections() if c.getTLSID()} if hasattr(n, "getConnections") else set()
        if not tls_ids and n.getID() not in programs:
            # typed as a traffic light but nothing is signal-controlled (e.g. 3 junctions in RESCO
            # Ingolstadt21): SUMO runs it as a priority junction, so don't draw it as a signal
            continue
        features.append(dict(
            type="Feature", geometry=dict(type="Point", coordinates=list(proj(x, y))),
            properties=dict(kind="signal", id=n.getID(), tls=sorted(tls_ids) or [n.getID()],
                            incoming=[e.getID() for e in n.getIncoming()],
                            outgoing=[e.getID() for e in n.getOutgoing()])))
    xs = [c[0] for f in features if f["geometry"]["type"] == "LineString" for c in f["geometry"]["coordinates"]]
    ys = [c[1] for f in features if f["geometry"]["type"] == "LineString" for c in f["geometry"]["coordinates"]]
    return dict(type="FeatureCollection", features=features,
                bbox=[min(xs), min(ys), max(xs), max(ys)], geo=geo)


def signal_programs(net_file: str) -> dict:
    """Signal programs per TLS id: phases with duration and state."""
    net = sumolib.net.readNet(net_file, withPrograms=True)
    out = {}
    for tls in net.getTrafficLights():
        progs = tls.getPrograms()
        if not progs:
            continue
        pid, prog = next(iter(progs.items()))
        phases = [dict(duration=p.duration, state=p.state) for p in prog.getPhases()]
        # which movement each character of the phase state controls: incoming road, outgoing road, turn
        links = {}
        for in_lane, out_lane, idx in tls.getConnections():
            ie, oe = in_lane.getEdge(), out_lane.getEdge()
            if idx in links:
                continue
            conns = ie.getConnections(oe)
            d = conns[0].getDirection() if conns else ""
            links[idx] = dict(index=idx, from_edge=ie.getID(), to_edge=oe.getID(),
                              turn={"s": "ahead", "l": "left", "L": "left", "r": "right", "R": "right",
                                    "t": "u-turn", "T": "u-turn"}.get(d, "ahead"))
        out[tls.getID()] = dict(program_id=pid, type=prog.getType(), offset=prog._offset if hasattr(prog, "_offset") else 0,
                                cycle_s=sum(p["duration"] for p in phases), phases=phases,
                                links=len(phases[0]["state"]) if phases else 0,
                                link_info=[links[i] for i in sorted(links)])
    return out


@lru_cache(maxsize=8)
def live_static(net_file: str, mtime: float) -> dict:
    """What the live map draws that does not change while it runs: every lane as its own strip, and a
    mark per signalled movement at the stop line (coloured each frame from the signal's state)."""
    net = sumolib.net.readNet(net_file, withPrograms=True)
    proj, geo = _projector(net)
    lanes = []
    for e in net.getEdges(withInternal=False):
        for ln in e.getLanes():
            lanes.append([ln.getID(), e.getID(), round(ln.getWidth(), 2), ln.allows("passenger"),
                          [[round(c, 7) for c in proj(x, y)] for x, y in ln.getShape()]])
    marks = []
    for t in net.getTrafficLights():
        by_lane: dict = {}
        for inl, outl, idx in t.getConnections():
            by_lane.setdefault(inl, []).append(idx)
        for inl, idxs in by_lane.items():
            shp = inl.getShape()
            (x0, y0), (x1, y1) = shp[-2], shp[-1]
            dx, dy = x1 - x0, y1 - y0
            d = math.hypot(dx, dy) or 1.0
            ux, uy = dx / d, dy / d
            idxs = sorted(set(idxs))
            for k, idx in enumerate(idxs):
                off = (k - (len(idxs) - 1) / 2) * min(1.1, inl.getWidth() / max(1, len(idxs)))
                x, y = x1 - ux * 1.5 - uy * off, y1 - uy * 1.5 + ux * off    # just behind the stop line
                lon, lat = proj(x, y)
                marks.append([t.getID(), idx, round(lon, 7), round(lat, 7)])
    return dict(lanes=lanes, signal_marks=marks, geo=geo)
