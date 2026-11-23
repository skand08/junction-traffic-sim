"""Readable labels for roads: street names where known, otherwise road type, plus direction of travel.

RESCO's Ingolstadt networks carry no street names, but their edge ids keep the OpenStreetMap way id
("-170018165#1" -> way 170018165). Names for those ways come from a small lookup file built from the
TUM sumo_ingolstadt network (OSM-derived). Labels are display-only; ids are unchanged everywhere.
"""
import json
import math
import re
from functools import lru_cache
from pathlib import Path

DATA = Path(__file__).resolve().parent / "data"
_FILES = {"ingolstadt7": "ingolstadt_street_names.json", "ingolstadt21": "ingolstadt_street_names.json"}
_HEADINGS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"]


@lru_cache(maxsize=8)
def street_names(base_network: str) -> dict:
    f = _FILES.get(base_network)
    if not f or not (DATA / f).exists():
        return {}
    return json.loads((DATA / f).read_text())["ways"]


def osm_way(edge_id: str) -> str:
    return re.sub(r"#.*", "", edge_id).lstrip("-")


def heading(coords: list) -> str:
    """Compass direction of travel from the first to the last point of a lon/lat (or x/y) line."""
    (x0, y0), (x1, y1) = coords[0], coords[-1]
    ang = math.degrees(math.atan2(x1 - x0, y1 - y0)) % 360     # 0 = north, clockwise
    return _HEADINGS[int((ang + 22.5) // 45) % 8]


def label_edges(features: list, base_network: str) -> None:
    """Add `name` (if found), `heading` and `label` to edge features, in place."""
    names = street_names(base_network)
    for f in features:
        p = f["properties"]
        if p.get("kind") != "edge":
            continue
        if not p.get("name"):
            p["name"] = names.get(osm_way(p["id"]), "")
        h = heading(f["geometry"]["coordinates"])
        p["heading"] = h
        if p["name"]:
            p["label"] = f"{p['name']}, {h}bound"
        else:
            kind = (p.get("road_type") or "").replace("_", " ")
            p["label"] = f"Unnamed {kind + ' ' if kind else ''}road, {h}bound"
