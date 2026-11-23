"""Scenario model, edit operations and file-based storage.

A scenario = base network + infrastructure edits + demand scale + signal controller.
Scenarios are stored as JSON in WORKSPACE_DIR/scenarios/<id>.json; the bundle format (§13, 1.7)
is the same JSON plus provenance, so export/import is a plain round trip.
"""
import json
import time
import uuid
from typing import Annotated, List, Literal, Optional, Union

from pydantic import BaseModel, Field

from . import config

SCEN_DIR = config.WORKSPACE_DIR / "scenarios"
SCEN_DIR.mkdir(parents=True, exist_ok=True)
BUNDLE_VERSION = "0.1"


class SetLanes(BaseModel):
    type: Literal["set_lanes"] = "set_lanes"
    edge: str
    lanes: int = Field(ge=1, le=8)


class SetSpeed(BaseModel):
    type: Literal["set_speed"] = "set_speed"
    edge: str
    speed_kmh: float = Field(gt=0, le=150)


class CloseRoad(BaseModel):
    type: Literal["close_road"] = "close_road"
    edge: str


class BanTurn(BaseModel):
    type: Literal["ban_turn"] = "ban_turn"
    from_edge: str
    to_edge: str


class RetimeSignal(BaseModel):
    """New fixed-time phase durations (seconds), one per phase of the signal's program."""
    type: Literal["retime_signal"] = "retime_signal"
    tls: str
    durations: List[float]


Edit = Annotated[Union[SetLanes, SetSpeed, CloseRoad, BanTurn, RetimeSignal], Field(discriminator="type")]
NETWORK_EDITS = ("set_lanes", "set_speed", "close_road", "ban_turn")


class Scenario(BaseModel):
    id: str = Field(default_factory=lambda: uuid.uuid4().hex[:10])
    name: str = "Untitled scenario"
    base_network: str
    demand_scale: float = Field(1.0, ge=0.1, le=3.0)
    controller: Literal["fixed", "actuated", "max_pressure"] = "fixed"
    edits: List[Edit] = Field(default_factory=list)
    parent_id: Optional[str] = None      # scenario this one was copied from (for before/after)
    created: float = Field(default_factory=time.time)

    def network_key(self) -> str:
        """Identifies the built network: only network-changing edits matter."""
        ed = [e.model_dump() for e in self.edits if e.type in NETWORK_EDITS]
        return json.dumps(dict(base=self.base_network, edits=ed), sort_keys=True)


def save(s: Scenario) -> Scenario:
    (SCEN_DIR / f"{s.id}.json").write_text(s.model_dump_json(indent=2))
    return s


def load(sid: str) -> Scenario:
    f = SCEN_DIR / f"{sid}.json"
    if not f.exists():
        raise KeyError(f"scenario '{sid}' not found")
    return Scenario.model_validate_json(f.read_text())


def list_all() -> list:
    out = [Scenario.model_validate_json(f.read_text()) for f in SCEN_DIR.glob("*.json")]
    return sorted(out, key=lambda s: s.created, reverse=True)


def delete(sid: str):
    (SCEN_DIR / f"{sid}.json").unlink(missing_ok=True)


def to_bundle(s: Scenario, seeds: list) -> dict:
    from . import catalog
    m = catalog.meta(s.base_network)
    return dict(bundle_version=BUNDLE_VERSION, scenario=s.model_dump(),
                run=dict(seeds=seeds, begin_s=m["begin"], end_s=m["end"], drain_s=config.DRAIN_S,
                         step_length_s=config.STEP_LENGTH),
                simulator=dict(engine="sumo", version=_sumo_version()),
                provenance=dict(exported=time.strftime("%Y-%m-%d %H:%M:%S"), data_licences=[m["license"]]))


def from_bundle(b: dict) -> Scenario:
    if str(b.get("bundle_version")) != BUNDLE_VERSION:
        raise ValueError(f"unsupported bundle version {b.get('bundle_version')}")
    data = dict(b["scenario"])
    data.pop("id", None)
    data["created"] = time.time()
    return Scenario.model_validate(data)


def _sumo_version() -> str:
    import subprocess
    r = subprocess.run([config.SUMO, "--version"], capture_output=True, text=True)
    return r.stdout.splitlines()[0].split()[-1] if r.stdout else "unknown"
