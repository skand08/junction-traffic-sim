"""Use a trained agent as a signal controller (greedy: no exploration), in batch runs, benchmarks and the
live view. Safety constraints come from the model's own training settings (minimum green, amber, all-red)."""
from pathlib import Path

import numpy as np

from .agents import DQN, PPO, Learners
from .env import SignalEnv
from .nn import load
from .train import Hyper


class ModelError(ValueError):
    """A model that cannot run on this network; the message is shown to the user."""


class RLController:
    def __init__(self, ls, net_file: str, model_path: str):
        arrays, meta = load(Path(model_path))
        self.meta = meta
        cfg = dict(observation=meta["observation"], action=meta["action"], reward=meta["reward"])
        self.env = SignalEnv(ls, net_file, cfg)
        env = self.env
        too_many = [t for t in env.ids if len(env.agents[t].greens) > meta["n_act"]]
        if too_many:
            raise ModelError(f"The agent was trained for junctions with up to {meta['n_act']} phases; "
                             f"{len(too_many)} signals here have more.")
        env.n_phases = meta["n_act"]                     # pad smaller junctions to the trained size
        if env.obs_size() != meta["n_obs"]:
            raise ModelError("The agent's observation settings do not fit this network.")
        if meta["sharing"] == "independent":
            missing = sorted(set(env.ids) - set(meta["ids"]))
            if missing:
                raise ModelError(f"This agent has one network per signal and was trained on {meta['network']}; "
                                 f"{len(missing)} signals here have no trained network. Use a shared-parameter agent "
                                 "to control other networks.")
            ids = meta["ids"]
        else:
            ids = env.ids
        hp = Hyper(hidden=meta["hidden"], buffer=1000).model_dump()
        self.learners = Learners(meta["algorithm"], meta["sharing"], ids, meta["n_obs"], meta["n_act"], hp, seed=0)
        self.learners.load(arrays)
        self.decisions: dict = {}                       # tid -> last decision, for the live view

    def step(self):
        env, ls = self.env, self.env.ls
        env.tick()
        t = ls.simulation.getTime()
        if int(t) % env.delta_t:
            return
        for tid in env.ids:
            if not env.ready(tid):
                continue
            o, m = env.observe(tid), env.mask(tid)
            lrn = self.learners.of[tid]
            if isinstance(lrn, PPO):
                vals = lrn.probs(o, m)
                kind = "probability"
            else:
                vals = lrn.values(o, m)
                kind = "value"
            k = int(np.argmax(vals))
            a = env.agents[tid]
            held = a.greens[k] == a.cur
            env.act(tid, k)
            n = len(a.greens)
            self.decisions[tid] = dict(t=t, chosen=k, held=held, kind=kind, values=[round(float(v), 3) for v in vals[:n]],
                                       phases=[a.phases[g][1] for g in a.greens])
