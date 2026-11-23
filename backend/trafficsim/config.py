"""Paths and SUMO locations shared by all backend modules."""
import os
import sys
from pathlib import Path

import sumo  # pip package "eclipse-sumo"

SUMO_HOME = Path(sumo.SUMO_HOME)
os.environ.setdefault("SUMO_HOME", str(SUMO_HOME))
TOOLS = SUMO_HOME / "tools"
if str(TOOLS) not in sys.path:
    sys.path.append(str(TOOLS))

BIN = SUMO_HOME / "bin"
SUMO = str(BIN / "sumo")
NETCONVERT = str(BIN / "netconvert")
NETGENERATE = str(BIN / "netgenerate")

BACKEND_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("TRAFFICSIM_DATA", BACKEND_DIR / "data"))
NETWORKS_DIR = DATA_DIR / "networks"
WORKSPACE_DIR = DATA_DIR / "workspace"
for d in (NETWORKS_DIR, WORKSPACE_DIR):
    d.mkdir(parents=True, exist_ok=True)

# Simulation defaults
DEFAULT_SEEDS = 10
DRAIN_S = 1800          # extra simulated time after the demand window so trips can finish
STEP_LENGTH = 1.0
MAX_WORKERS = int(os.environ.get("TRAFFICSIM_WORKERS", max(1, (os.cpu_count() or 2) - 1)))
