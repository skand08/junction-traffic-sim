"""Catalog of base networks the app offers.

Each prepared network lives in NETWORKS_DIR/<id>/ with:
  net.net.xml     SUMO network
  demand.rou.xml  trips or routes for the demand window
  meta.json       name, description, window, geo flag, licence
Synthetic networks are generated on first use; RESCO networks are copied from a RESCO checkout.
"""
import json
import os
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

from . import config

RESCO_DIR = Path(os.environ.get(
    "TRAFFICSIM_RESCO_DIR", config.DATA_DIR / "resco" / "resco_benchmark" / "environments"))

SPECS = {
    "grid3x3": dict(
        kind="synthetic", name="Practice grid",
        description="A simple 3 × 3 street grid with 9 traffic signals. Good for a first try.", note="",
        netgenerate=["--grid", "--grid.number", "3", "--grid.length", "200",
                     "--grid.attach-length", "200", "--default.lanenumber", "2",
                     "--default.speed", "13.89", "--tls.guess", "true", "--tls.default-type", "static"],
        trips_period=1.6),
    "corridor5": dict(
        kind="synthetic", name="Main road corridor",
        description="One main road with 5 signalled crossings.", note="",
        netgenerate=["--grid", "--grid.x-number", "5", "--grid.y-number", "1",
                     "--grid.x-length", "250", "--grid.attach-length", "200",
                     "--default.lanenumber", "2", "--default.speed", "13.89",
                     "--tls.guess", "true", "--tls.default-type", "static"],
        trips_period=1.4),
    "ingolstadt7": dict(
        kind="resco", name="Ingolstadt main road",
        description="A real main road in Ingolstadt, Germany, with 7 signals.",
        note="Signal timings are standard 90-second plans, not the city's real ones.",
        resco="ingolstadt7"),
    "ingolstadt21": dict(
        kind="resco", name="Ingolstadt district",
        description="A real district of Ingolstadt, Germany, with 21 signals.",
        note="Signal timings are standard 90-second plans, not the city's real ones.",
        resco="ingolstadt21"),
}

RESCO_LICENSE = "RESCO / InTAS scenario, CC BY-NC-SA 4.0 (non-commercial research use)"


def _run(cmd, cwd=None):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"{Path(cmd[0]).name} failed: {r.stderr.strip()[-800:]}")
    return r


def _prepare_synthetic(nid, spec, out: Path):
    net = out / "net.net.xml"
    _run([config.NETGENERATE, *spec["netgenerate"], "--seed", "1", "-o", str(net)])
    trips = out / "demand.rou.xml"
    _run([sys.executable, str(config.TOOLS / "randomTrips.py"), "-n", str(net), "-o", str(trips),
          "-b", "0", "-e", "3600", "-p", str(spec["trips_period"]), "--seed", "42",
          "--fringe-factor", "10", "--min-distance", "300", "--validate"], cwd=out)
    for f in out.glob("*.alt.xml"):
        f.unlink()
    return dict(begin=0, end=3600, geo=False, license="Generated (netgenerate + randomTrips), no restrictions")


def _prepare_resco(nid, spec, out: Path):
    src = RESCO_DIR / spec["resco"]
    if not src.exists():
        raise FileNotFoundError(f"RESCO scenario not found at {src}; set TRAFFICSIM_RESCO_DIR")
    cfg = ET.parse(src / f"{spec['resco']}.sumocfg").getroot()
    shutil.copy(src / cfg.find(".//net-file").get("value"), out / "net.net.xml")
    shutil.copy(src / cfg.find(".//route-files").get("value"), out / "demand.rou.xml")
    b = int(float(cfg.find(".//begin").get("value")))
    e = int(float(cfg.find(".//end").get("value")))
    return dict(begin=b, end=e, geo=True, license=RESCO_LICENSE)


def ensure_network(nid: str) -> Path:
    """Return the prepared directory for a base network, building it if needed."""
    if nid not in SPECS:
        user = config.NETWORKS_DIR / nid
        if "/" not in nid and ".." not in nid and (user / "meta.json").exists():
            return user                      # an imported network
        raise KeyError(f"unknown network '{nid}'")
    out = config.NETWORKS_DIR / nid
    meta_f = out / "meta.json"
    if meta_f.exists():
        return out
    out.mkdir(parents=True, exist_ok=True)
    spec = SPECS[nid]
    extra = (_prepare_synthetic if spec["kind"] == "synthetic" else _prepare_resco)(nid, spec, out)
    meta = dict(id=nid, name=spec["name"], description=spec["description"], kind=spec["kind"], **extra)
    meta.update(_net_stats(out / "net.net.xml"), trips=_count_trips(out / "demand.rou.xml"))
    meta_f.write_text(json.dumps(meta, indent=2))
    return out


def _net_stats(net_file: Path) -> dict:
    root = ET.parse(net_file).getroot()
    edges = [e for e in root.iter("edge") if e.get("function") != "internal"]
    return dict(edges=len(edges), signals=len({t.get("id") for t in root.iter("tlLogic")}))


def _count_trips(rou: Path) -> int:
    root = ET.parse(rou).getroot()
    return sum(1 for _ in root.iter("trip")) + sum(1 for _ in root.iter("vehicle"))


def meta(nid: str) -> dict:
    m = json.loads((ensure_network(nid) / "meta.json").read_text())
    if nid not in SPECS:
        return m
    return dict(m, name=SPECS[nid]["name"], description=SPECS[nid]["description"], note=SPECS[nid].get("note", ""))


def list_networks() -> list:
    out = []
    for nid, spec in SPECS.items():
        m = config.NETWORKS_DIR / nid / "meta.json"
        # name and description always come from SPECS, so wording fixes reach networks prepared earlier
        out.append(dict(json.loads(m.read_text()), name=spec["name"], description=spec["description"], note=spec.get("note", "")) if m.exists()
                   else dict(id=nid, name=spec["name"], description=spec["description"], note=spec.get("note", ""), kind=spec["kind"],
                             prepared=False))
    for m in sorted(config.NETWORKS_DIR.glob("*/meta.json"), key=lambda f: f.stat().st_mtime):
        if m.parent.name not in SPECS:
            out.append(json.loads(m.read_text()))
    return out
