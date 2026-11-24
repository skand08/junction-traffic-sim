"""Add networks to the library: from OpenStreetMap (a file, or an area downloaded from the Overpass API)
or from a SUMO network file.

Imported networks live next to the built-in ones in NETWORKS_DIR/<id>/ (net.net.xml, demand.rou.xml,
meta.json with kind="imported"). OSM has no traffic counts, so their demand is generated with SUMO's
randomTrips; the network's note says so.
"""
import gzip
import bz2
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

from . import catalog, config

# Public Overpass servers, tried in order; set TRAFFICSIM_OVERPASS to use your own (comma-separated).
OVERPASS_URLS = [u.strip() for u in os.environ.get(
    "TRAFFICSIM_OVERPASS",
    "https://overpass-api.de/api/interpreter,https://overpass.private.coffee/api/interpreter").split(",") if u.strip()]
BUSY = {429, 502, 503, 504}   # Overpass answers these when it is at capacity
MAX_AREA_KM2 = float(os.environ.get("TRAFFICSIM_MAX_IMPORT_KM2", "6"))
OSM_LICENSE = "© OpenStreetMap contributors (ODbL). Traffic generated randomly by SUMO randomTrips."
DEFAULT_TRIPS_PER_KM = 150     # trips per hour per km of road; a moderate default the user can change


class ImportError_(Exception):
    """A problem the user can fix (bad file, area too large, OSM unreachable)."""


def _env():
    return config.tool_env()


def _run(cmd, cwd=None, what="conversion"):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, env=_env())
    if r.returncode != 0:
        tail = (r.stderr or r.stdout).strip().splitlines()[-6:]
        raise ImportError_(f"The {what} failed: " + " ".join(tail)[-500:])
    return r


def area_km2(bbox) -> float:
    w, s, e, n = bbox
    lat = math.radians((s + n) / 2)
    return abs(e - w) * 111.32 * math.cos(lat) * abs(n - s) * 110.57


def _done(dest: Path) -> bool:
    return dest.stat().st_size >= 200 and b"<osm" in dest.read_bytes()[:2000]


def fetch_osm_bbox(bbox, dest: Path) -> Path:
    """Download the roads in bbox = [west, south, east, north] from the Overpass API."""
    w, s, e, n = [float(x) for x in bbox]
    if not (-180 <= w < e <= 180 and -90 <= s < n <= 90):
        raise ImportError_("The area is not valid. Give west < east and south < north in degrees.")
    a = area_km2((w, s, e, n))
    if a > MAX_AREA_KM2:
        raise ImportError_(f"The area is {a:.1f} km²; the limit is {MAX_AREA_KM2:g} km². Zoom in and try again.")
    q = f'[out:xml][timeout:90];(way["highway"]({s},{w},{n},{e});>;);out body;'
    body = urllib.parse.urlencode({"data": q}).encode()
    busy, last = False, None
    for url in OVERPASS_URLS:
        for wait in (0, 3, 8):            # back off while the server says it is at capacity
            time.sleep(wait)
            req = urllib.request.Request(url, data=body, headers={"User-Agent": "Junction traffic simulator"})
            try:
                with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
                    shutil.copyfileobj(r, f)
                if _done(dest):
                    return _check_roads(dest)
                last = "the server sent an unexpected reply"
                break
            except urllib.error.HTTPError as ex:
                last = ex
                if ex.code not in BUSY:
                    break                  # a real error from this server: try the next one
                busy = True
            except Exception as ex:  # noqa: BLE001
                last = ex
                break
    if busy:
        raise ImportError_("OpenStreetMap's download service (Overpass API) is busy right now. "
                           "Try again in a few minutes, or download an .osm file and upload it instead.")
    raise ImportError_(f"Could not download from OpenStreetMap (Overpass API): {last}. "
                       "Check the internet connection, or download an .osm file and upload it instead.")


def _check_roads(dest: Path) -> Path:
    if dest.stat().st_size < 200 or b"<way" not in dest.read_bytes()[:5_000_000]:
        raise ImportError_("OpenStreetMap returned no roads for this area.")
    return dest


def _decompress(src: Path) -> Path:
    head = src.read_bytes()[:4]
    if head[:2] == b"\x1f\x8b":
        out = src.parent / "decompressed.osm"
        with gzip.open(src) as i, open(out, "wb") as o:
            shutil.copyfileobj(i, o)
        return out
    if head[:3] == b"BZh":
        out = src.parent / "decompressed.osm"
        with bz2.open(src) as i, open(out, "wb") as o:
            shutil.copyfileobj(i, o)
        return out
    return src


def _new_id(prefix: str, name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:24] or "network"
    return f"{prefix}-{slug}-{uuid.uuid4().hex[:4]}"


def _road_km(net: Path) -> float:
    import sumolib
    n = sumolib.net.readNet(str(net))
    return sum(e.getLength() for e in n.getEdges() if e.getFunction() != "internal" and e.allows("passenger")) / 1000


def _demand(net: Path, out: Path, trips_per_hour: int | None) -> int:
    km = _road_km(net)
    trips = int(trips_per_hour or max(100, min(8000, round(km * DEFAULT_TRIPS_PER_KM))))
    period = 3600.0 / trips
    rou = out / "demand.rou.xml"
    _run([sys.executable, str(config.TOOLS / "randomTrips.py"), "-n", str(net), "-o", str(rou),
          "-b", "0", "-e", "3600", "-p", f"{period:.4f}", "--seed", "42", "--fringe-factor", "5",
          "--min-distance", "200", "--validate"], cwd=out, what="traffic generation")
    for f in out.glob("*.alt.xml"):
        f.unlink()
    return trips


def _finish(nid, out: Path, name, description, source, license_, note, geo=True):
    meta = dict(id=nid, name=name, description=description, kind="imported", source=source,
                note=note, license=license_, begin=0, end=3600, geo=geo, created=time.time())
    meta.update(catalog._net_stats(out / "net.net.xml"), trips=catalog._count_trips(out / "demand.rou.xml"))
    if meta["edges"] == 0:
        raise ImportError_("No drivable roads were found in this data.")
    (out / "meta.json").write_text(json.dumps(meta, indent=2))
    return meta


def import_osm(osm_file: Path, name: str, trips_per_hour: int | None = None, source="OpenStreetMap") -> dict:
    nid = _new_id("osm", name)
    out = config.NETWORKS_DIR / nid
    out.mkdir(parents=True)
    try:
        src = _decompress(osm_file)
        _run([config.NETCONVERT, "--osm-files", str(src), "-o", str(out / "net.net.xml"),
              "--geometry.remove", "--ramps.guess", "--junctions.join", "--edges.join",
              "--tls.guess-signals", "--tls.discard-simple", "--tls.join", "--tls.default-type", "static",
              "--remove-edges.isolated", "--keep-edges.by-vclass", "passenger",
              "--output.street-names", "--no-warnings"], what="OpenStreetMap conversion")
        trips = _demand(out / "net.net.xml", out, trips_per_hour)
        return _finish(nid, out, name, f"Imported from {source}.", "osm", OSM_LICENSE,
                       f"Traffic is randomly generated ({trips:,} trips in one hour), not measured.")
    except Exception:
        shutil.rmtree(out, ignore_errors=True)
        raise


def import_sumo(net_file: Path, name: str, routes: Path | None = None, trips_per_hour: int | None = None) -> dict:
    nid = _new_id("sumo", name)
    out = config.NETWORKS_DIR / nid
    out.mkdir(parents=True)
    try:
        net = out / "net.net.xml"
        # re-write through netconvert: validates the file and normalises it for later edits
        _run([config.NETCONVERT, "-s", str(net_file), "-o", str(net), "--no-warnings"], what="network check")
        if routes:
            shutil.copy(routes, out / "demand.rou.xml")
            note, lic = "Traffic from the uploaded route file.", "Uploaded by the user."
        else:
            trips = _demand(net, out, trips_per_hour)
            note, lic = f"Traffic is randomly generated ({trips:,} trips in one hour), not measured.", "Uploaded by the user; traffic generated by SUMO randomTrips."
        import sumolib
        geo = bool(sumolib.net.readNet(str(net)).hasGeoProj())
        return _finish(nid, out, name, "Uploaded SUMO network.", "sumo", lic, note, geo=geo)
    except Exception:
        shutil.rmtree(out, ignore_errors=True)
        raise


def delete_network(nid: str):
    if nid in catalog.SPECS:
        raise ImportError_("Built-in networks cannot be deleted.")
    d = config.NETWORKS_DIR / nid
    if "/" in nid or ".." in nid or not (d / "meta.json").exists():
        raise KeyError(f"network '{nid}' not found")
    shutil.rmtree(d)
