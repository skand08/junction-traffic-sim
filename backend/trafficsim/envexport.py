"""Export a scenario as a self-contained multi-agent RL environment, so researchers can train with their own
code (Stable-Baselines3, RLlib, CleanRL, plain PyTorch...) on exactly the problem Junction uses.

The zip holds the built network and demand, the settings, and a small `junction_env` package whose signal
logic (observation, safe phase changes, reward) is copied from Junction's own source at export time, so an
agent trained outside sees the same problem as one trained inside. It needs only SUMO and NumPy; the API
follows PettingZoo's parallel interface, and Gymnasium spaces are used when Gymnasium is installed.
A policy trained this way can then be benchmarked in Junction through the external controller protocol.
"""
import hashlib
import inspect
import io
import json
import time
import zipfile
from pathlib import Path
from typing import List, Literal

from pydantic import BaseModel, Field

from . import build, runner, scenario as sc
from .jobs import versions
from .rl import env as rl_env
from .rl.train import ActCfg, ObsCfg

ENV_VERSION = "junction-env/1"


class EnvCfg(BaseModel):
    observation: ObsCfg = ObsCfg()
    action: ActCfg = ActCfg()
    reward: Literal["pressure", "queue", "waiting"] = "pressure"
    episode_min: int = Field(30, ge=5, le=60)
    demand_scales: List[float] = [1.0]


_CORE = '''"""Copied from Junction (trafficsim.runner) at export time: how far queues are counted from a signal."""
MP_REACH_M = {reach}


{is_green}

{lane_reach}
'''

_INIT = r'''"""Junction signal-control environment ({version}), exported from Junction.

    from junction_env import JunctionParallelEnv
    env = JunctionParallelEnv()                 # reads config.json, net.net.xml and demand.rou.xml next to it
    obs, infos = env.reset(seed=1)
    while env.agents:
        actions = {{a: int(infos[a]["action_mask"].nonzero()[0][0]) for a in env.agents}}
        obs, rewards, terminations, truncations, infos = env.step(actions)
    env.close()

Each agent is a signal. An action is the index of the green phase to show next; only the first
`infos[agent]["action_mask"].sum()` options exist at that junction. A step is `delta_t` simulated seconds.
Actions are applied only when the signal is free (`infos[agent]["ready"]`); minimum green, amber and all-red
are always enforced, as in Junction.
"""
import json
import uuid
from pathlib import Path

import numpy as np

from .signal_env import SignalEnv

HERE = Path(__file__).resolve().parent.parent

try:                                            # optional: proper spaces for RL libraries
    from gymnasium import spaces as _spaces
except ImportError:                             # pragma: no cover
    _spaces = None


class _Box:
    def __init__(self, shape):
        self.shape, self.dtype = shape, np.float64

    def __repr__(self):
        return f"Box(shape={{self.shape}})"


class _Discrete:
    def __init__(self, n):
        self.n = n

    def __repr__(self):
        return f"Discrete({{self.n}})"


class JunctionParallelEnv:
    metadata = {{"name": "junction_signals_v1", "is_parallelizable": True}}

    def __init__(self, bundle_dir=None, episode_min=None, demand_scales=None, libsumo=True, sumo_binary="sumo",
                 extra_sumo_args=None):
        self.dir = Path(bundle_dir) if bundle_dir else HERE
        self.cfg = json.loads((self.dir / "config.json").read_text())
        self.episode_min = episode_min or self.cfg["episode_min"]
        self.demand_scales = demand_scales or self.cfg["demand_scales"]
        self.libsumo, self.binary, self.extra = libsumo, sumo_binary, list(extra_sumo_args or [])
        self.net_file = str(self.dir / "net.net.xml")
        self._reach_cache = {{}}
        self._ls, self._label, self.env = None, None, None
        self.rng = np.random.default_rng()
        self.possible_agents = list(self.cfg["agents"])
        self.agents = []
        self.n_obs, self.n_act = self.cfg["n_obs"], self.cfg["n_act"]

    # ---------- spaces ----------
    def observation_space(self, agent):
        return _spaces.Box(-np.inf, np.inf, (self.n_obs,), np.float64) if _spaces else _Box((self.n_obs,))

    def action_space(self, agent):
        return _spaces.Discrete(self.n_act) if _spaces else _Discrete(self.n_act)

    # ---------- episode ----------
    def _start(self, seed, scale):
        r = self.cfg["sumo"]
        args = [self.binary, "-n", self.net_file, "-r", str(self.dir / "demand.rou.xml"),
                "--begin", str(r["begin"]), "--end", str(r["begin"] + self.episode_min * 60 + 1),
                "--scale", str(scale), "--seed", str(seed), "--step-length", str(r["step_length"]),
                "--time-to-teleport", str(r["time_to_teleport"]), "--ignore-route-errors", "true",
                "--ignore-junction-blocker", str(r["ignore_junction_blocker"]),
                "--no-step-log", "true", "--no-warnings", "true", *self.extra]
        if self.libsumo:
            import libsumo
            libsumo.start(args)
            self._ls = libsumo
        else:                                   # TraCI: slower, but several environments per process
            import traci
            self._label = "junction-" + uuid.uuid4().hex[:8]
            traci.start(args, label=self._label)
            self._ls = traci.getConnection(self._label)

    def reset(self, seed=None, options=None):
        if seed is not None:
            self.rng = np.random.default_rng(seed)
        self.close()
        sumo_seed = int(self.rng.integers(1, 2**31 - 1))
        scale = float(self.rng.choice(self.demand_scales))
        self._start(sumo_seed, scale)
        self.env = SignalEnv(self._ls, self.net_file, self.cfg["signal"], self._reach_cache)
        if self.env.n_phases > self.n_act:
            raise RuntimeError("a signal has more phases than this export was made for")
        self.env.n_phases = self.n_act
        self.end = self._ls.simulation.getTime() + self.episode_min * 60
        self.agents = list(self.env.ids)
        self.info_episode = dict(sumo_seed=sumo_seed, demand_scale=scale)
        return self._obs(), self._infos()

    def _obs(self):
        return {{a: self.env.observe(a) for a in self.agents}}

    def _infos(self):
        return {{a: dict(action_mask=self.env.mask(a), ready=self.env.ready(a), time_s=self._ls.simulation.getTime())
                 for a in self.agents}}

    def step(self, actions):
        env, ls = self.env, self._ls
        for a, k in actions.items():
            if a in env.agents and env.ready(a):
                env.act(a, int(k))
        for _ in range(env.delta_t):
            ls.simulationStep()
            env.tick()
            if ls.simulation.getTime() >= self.end:
                break
        done = ls.simulation.getTime() >= self.end
        obs, infos = self._obs(), self._infos()
        rewards = {{a: float(env.reward(a)) for a in self.agents}}
        terms = {{a: False for a in self.agents}}
        truncs = {{a: done for a in self.agents}}
        if done:
            self.agents = []
        return obs, rewards, terms, truncs, infos

    def close(self):
        if self._ls is not None:
            try:
                self._ls.close()
            except Exception:
                pass
        self._ls = None


def parallel_env(**kw):
    return JunctionParallelEnv(**kw)
'''

_EXAMPLE = '''"""Smoke test and baseline: a random policy for one episode. Run: python example_random.py"""
import numpy as np
from junction_env import JunctionParallelEnv

env = JunctionParallelEnv()
obs, infos = env.reset(seed=1)
rng = np.random.default_rng(1)
total, steps = 0.0, 0
while env.agents:
    actions = {a: int(rng.choice(np.flatnonzero(infos[a]["action_mask"]))) for a in env.agents}
    obs, rewards, terms, truncs, infos = env.step(actions)
    total += sum(rewards.values())
    steps += 1
env.close()
print(f"{len(env.possible_agents)} agents, {steps} steps, mean reward per agent-step "
      f"{total / max(1, steps * len(env.possible_agents)):.4f}")
'''

_README = """# {name}: signal-control environment exported from Junction

Scenario **{scenario}** on network **{network}** ({agents} signals), exported {date}.

## Install and run

```
pip install eclipse-sumo numpy        # gymnasium is optional (proper spaces for RL libraries)
python example_random.py
```

## Use

```python
from junction_env import JunctionParallelEnv
env = JunctionParallelEnv()               # PettingZoo parallel API
obs, infos = env.reset(seed=1)
obs, rewards, terminations, truncations, infos = env.step({{agent: 0 for agent in env.agents}})
```

- **Agents:** one per signal with two or more greens ({agents} here).
- **Action:** index of the green to show next (`Discrete({n_act})`). Only `infos[agent]["action_mask"]` options exist;
  actions apply only when `infos[agent]["ready"]`. Minimum green {min_green} s, amber {amber} s, all-red {all_red} s are enforced.
- **Observation:** {n_obs} numbers: {obs_text}. Counted over {reach} m of road from the stop line.
- **Reward:** {reward}.
- **Step:** {delta_t} simulated seconds. **Episode:** {episode_min} minutes of traffic, demand scale drawn from {scales}.
- `libsumo=True` (default) is fast but allows one environment per process; use `libsumo=False` (TraCI) for several.

## Benchmark your trained policy in Junction

Serve the policy with the external controller protocol (see `external_controller.py` in Junction's `examples` folder):
Junction sends the same per-green measurements and applies the same safety rules, then compares your policy
with fixed, actuated, max-pressure and Junction-trained agents on identical traffic.

## Provenance

`config.json` records the scenario, its edits, Junction and SUMO versions and a hash of the network.
"""


def _core_source() -> str:
    return _CORE.format(reach=runner.MP_REACH_M, is_green=inspect.getsource(runner._is_green),
                        lane_reach=inspect.getsource(runner._lane_reach))


def _env_source() -> str:
    src = inspect.getsource(rl_env)
    line = "from ..runner import _is_green, _lane_reach"
    if line not in src:
        raise RuntimeError("rl/env.py imports changed; update envexport")
    return src.replace(line, "from ._core import _is_green, _lane_reach")


def _signal_shape(net_file: Path, demand_file: Path, begin: int, cfg: EnvCfg) -> dict:
    """Start SUMO briefly to read the agents and the observation size (as the training code does)."""
    import libsumo as ls
    ls.start(["sumo", "-n", str(net_file), "-r", str(demand_file), "--begin", str(begin), "--end", str(begin + 2),
              "--no-step-log", "true", "--no-warnings", "true"])
    try:
        env = rl_env.SignalEnv(ls, str(net_file), _signal_cfg(cfg))
        return dict(agents=env.ids, n_obs=env.obs_size(), n_act=env.n_phases,
                    phases={t: [env.agents[t].phases[g][1] for g in env.agents[t].greens] for t in env.ids})
    finally:
        ls.close()


def _signal_cfg(cfg: EnvCfg) -> dict:
    return dict(observation=cfg.observation.model_dump(), action=cfg.action.model_dump(), reward=cfg.reward)


def export(s: sc.Scenario, cfg: EnvCfg, work: Path) -> bytes:
    """Build the scenario and return the zip. Runs SUMO for a moment, so call it in a worker process."""
    from multiprocessing import get_context
    b = build.build(s.model_copy(update=dict(controller="fixed")), work)
    with get_context("spawn").Pool(1) as pool:       # libsumo is one simulation per process
        shape = pool.apply(_signal_shape, (b.net_file, b.demand_file, b.begin, cfg))
    if not shape["agents"]:
        raise ValueError("This scenario has no signals with two or more greens to control.")
    net_bytes = Path(b.net_file).read_bytes()
    obs_text = ", ".join(
        [f"for each of up to {shape['n_act']} greens: " + "/".join(
            f for f in ("queue", "approaching", "out_queue") if f in cfg.observation.features) + " (÷10)"]
        + (["one-hot current green"] if "phase" in cfg.observation.features else [])
        + (["time in green (÷120 s, capped at 1) and a changing flag"] if "elapsed" in cfg.observation.features else []))
    from . import config as appcfg
    conf = dict(
        format=ENV_VERSION, exported=time.time(), versions=versions(), scenario=s.model_dump(mode="json"),
        network_sha256=hashlib.sha256(net_bytes).hexdigest(), signal=_signal_cfg(cfg),
        episode_min=cfg.episode_min, demand_scales=cfg.demand_scales, agents=shape["agents"], n_obs=shape["n_obs"],
        n_act=shape["n_act"], phases=shape["phases"],
        sumo=dict(begin=b.begin, step_length=appcfg.STEP_LENGTH, time_to_teleport=runner.TELEPORT_S,
                  ignore_junction_blocker=runner.JUNCTION_BLOCKER_S))
    reward_text = {"pressure": "minus |vehicles queued to enter − queued beyond| over all movements, ÷10 (PressLight)",
                   "queue": "minus the stopped vehicles on the approaches, ÷10",
                   "waiting": "minus the increase in total waiting time on the approaches since the last step, ÷100"}
    readme = _README.format(
        name=s.name, scenario=s.name, network=s.base_network, agents=len(shape["agents"]), date=time.strftime("%Y-%m-%d"),
        n_act=shape["n_act"], n_obs=shape["n_obs"], obs_text=obs_text, reach=cfg.observation.reach_m,
        min_green=cfg.action.min_green, amber=cfg.action.amber, all_red=cfg.action.all_red,
        reward=reward_text[cfg.reward], delta_t=cfg.action.delta_t, episode_min=cfg.episode_min, scales=cfg.demand_scales)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("config.json", json.dumps(conf, indent=1))
        z.writestr("net.net.xml", net_bytes)
        z.write(b.demand_file, "demand.rou.xml")
        z.writestr("junction_env/__init__.py", _INIT.format(version=ENV_VERSION))
        z.writestr("junction_env/_core.py", _core_source())
        z.writestr("junction_env/signal_env.py", _env_source())
        z.writestr("example_random.py", _EXAMPLE)
        z.writestr("README.md", readme)
    return buf.getvalue()
