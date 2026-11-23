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
                priority=e.getPriority())))
    for n in net.getNodes():
        if n.getType() not in ("traffic_light", "traffic_light_right_on_red", "traffic_light_unregulated"):
            continue
        x, y = n.getCoord()
        tls_ids = {c.getTLSID() for c in n.getConnections() if c.getTLSID()} if hasattr(n, "getConnections") else set()
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
