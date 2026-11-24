"""Signal-control environment over a running SUMO simulation (libsumo).

Every signal with two or more green phases is an agent. Every `delta_t` simulated seconds, each agent that
is free to act (not changing phase, and past its minimum green) picks one of its green phases. Keeping the
current phase holds it; any other phase starts the same safe transition the pressure controller uses:
amber for movements losing green, then all-red, then the new green. Safety cannot be bypassed by a policy.

Observation (phase level, as in FRAP/MPLight, so one network can serve junctions of any shape): for each of
the agent's green phases, the queue waiting to use it, the vehicles approaching it and the queue beyond it,
counted over `reach_m` metres of road; plus the current phase and the time spent in it. Phases are padded
to a fixed count with an action mask.
"""
from dataclasses import dataclass, field
from typing import Dict, List

import numpy as np

from ..runner import _is_green, _lane_reach

FEATURES = ("queue", "approaching", "out_queue", "phase", "elapsed")


@dataclass
class Agent:
    tid: str
    phases: list                    # (duration, state) of the original program
    greens: list                    # indices of green phases the agent can choose
    mov: Dict[int, list]            # green index -> [(in_lane, out_lane)]
    program: str
    cur: int
    since: float
    until: float | None = None      # end of the running amber/all-red step
    queue: list = field(default_factory=list)
    target: int | None = None
    last_wait: float = 0.0


class SignalEnv:
    def __init__(self, ls, net_file: str, cfg: dict, reach_cache: dict | None = None):
        self.ls = ls
        obs, act = cfg["observation"], cfg["action"]
        self.features = [f for f in FEATURES if f in obs.get("features", FEATURES)]
        self.reach = float(obs.get("reach_m", 60))
        self.delta_t = int(act.get("delta_t", 5))
        self.min_green = float(act.get("min_green", 10))
        self.amber = float(act.get("amber", 3))
        self.all_red = float(act.get("all_red", 2))
        self.reward_kind = cfg.get("reward", "pressure")
        key = (net_file, self.reach)
        if reach_cache is not None and key in reach_cache:
            self.fwd, self.back = reach_cache[key]
        else:                                          # the same reach logic as pressure control, at this distance
            self.fwd, self.back = _lane_reach(net_file, self.reach)
            if reach_cache is not None:
                reach_cache[key] = (self.fwd, self.back)
        self.agents: Dict[str, Agent] = {}
        for tid in ls.trafficlight.getIDList():
            logic = ls.trafficlight.getAllProgramLogics(tid)[0]
            phases = [(p.duration, p.state) for p in logic.phases]
            greens = [i for i, (_, s) in enumerate(phases) if _is_green(s)]
            covered = {k for g in greens for k, ch in enumerate(phases[g][1]) if ch in "Gg"}
            for i, (_, s) in enumerate(phases):
                if i not in greens and any(ch in "Gg" and k not in covered for k, ch in enumerate(s)):
                    greens.append(i)
                    covered |= {k for k, ch in enumerate(s) if ch in "Gg"}
            if len(greens) < 2:
                continue
            links = ls.trafficlight.getControlledLinks(tid)
            mov = {g: [(l[0][0], l[0][1]) for i, l in enumerate(links) if l and phases[g][1][i] in "Gg"] for g in greens}
            ls.trafficlight.setPhase(tid, greens[0])
            ls.trafficlight.setPhaseDuration(tid, 1e6)
            self.agents[tid] = Agent(tid, phases, greens, mov, ls.trafficlight.getProgram(tid), greens[0], ls.simulation.getTime())
        self.ids = sorted(self.agents)
        self.n_phases = max([len(a.greens) for a in self.agents.values()], default=2)
        self._halt: dict = {}
        self._veh: dict = {}

    # ---------- measurements ----------
    def _refresh(self):
        self._halt, self._veh = {}, {}

    def _h(self, lane):
        if lane not in self._halt:
            self._halt[lane] = self.ls.lane.getLastStepHaltingNumber(lane)
        return self._halt[lane]

    def _v(self, lane):
        if lane not in self._veh:
            self._veh[lane] = self.ls.lane.getLastStepVehicleNumber(lane)
        return self._veh[lane]

    def _phase_feats(self, a: Agent, g: int):
        q = ap = out = 0.0
        ins = {i for i, _ in a.mov[g]}
        outs = {o for _, o in a.mov[g]}
        for i in ins:
            for x in self.back.get(i, [i]):
                h = self._h(x)
                q += h
                ap += self._v(x) - h
        for o in outs:
            for x in self.fwd.get(o, [o]):
                out += self._h(x)
        return q, ap, out

    def obs_size(self) -> int:
        n = 0
        per = sum(f in self.features for f in ("queue", "approaching", "out_queue"))
        n += per * self.n_phases
        if "phase" in self.features:
            n += self.n_phases
        if "elapsed" in self.features:
            n += 2
        return n

    def observe(self, tid: str) -> np.ndarray:
        a = self.agents[tid]
        now = self.ls.simulation.getTime()
        x: List[float] = []
        cols = [f for f in ("queue", "approaching", "out_queue") if f in self.features]
        feats = [self._phase_feats(a, g) for g in a.greens]
        for k in range(self.n_phases):
            q, ap, out = feats[k] if k < len(feats) else (0.0, 0.0, 0.0)
            vals = dict(queue=q / 10.0, approaching=ap / 10.0, out_queue=out / 10.0)
            x.extend(vals[c] for c in cols)
        if "phase" in self.features:
            oh = [0.0] * self.n_phases
            if a.cur in a.greens:
                oh[a.greens.index(a.cur)] = 1.0
            x.extend(oh)
        if "elapsed" in self.features:
            x.extend([min(1.0, (now - a.since) / 120.0), 1.0 if a.until is not None else 0.0])
        return np.asarray(x, dtype=np.float64)

    def mask(self, tid: str) -> np.ndarray:
        m = np.zeros(self.n_phases, dtype=bool)
        m[: len(self.agents[tid].greens)] = True
        return m

    def reward(self, tid: str) -> float:
        a = self.agents[tid]
        if self.reward_kind == "queue":
            lanes = {x for g in a.greens for i, _ in a.mov[g] for x in self.back.get(i, [i])}
            return -sum(self._h(x) for x in lanes) / 10.0
        if self.reward_kind == "waiting":
            lanes = {x for g in a.greens for i, _ in a.mov[g] for x in self.back.get(i, [i])}
            w = sum(self.ls.lane.getWaitingTime(x) for x in lanes)
            r = -(w - a.last_wait) / 100.0 if a.last_wait or w else 0.0
            a.last_wait = w
            return r
        # pressure (PressLight): queue in minus queue out over every movement, negated
        p = 0.0
        for g in a.greens:
            for i, o in a.mov[g]:
                p += sum(self._h(x) for x in self.back.get(i, [i])) - sum(self._h(x) for x in self.fwd.get(o, [o]))
        return -abs(p) / 10.0

    # ---------- control ----------
    def ready(self, tid: str) -> bool:
        a = self.agents[tid]
        return a.until is None and self.ls.simulation.getTime() - a.since >= self.min_green

    def act(self, tid: str, k: int):
        """Choose green phase number k (0-based among the agent's greens). Keeping the current one holds it."""
        a = self.agents[tid]
        if not self.ready(tid) or k >= len(a.greens):
            return
        best = a.greens[k]
        if best == a.cur:
            return
        ls, now = self.ls, self.ls.simulation.getTime()
        cur_s, tgt_s = a.phases[a.cur][1], a.phases[best][1]
        keep = [x in "Gg" and y in "Gg" for x, y in zip(cur_s, tgt_s)]
        amber = "".join(x if kk else ("y" if x in "Gg" else "r") for x, kk in zip(cur_s, keep))
        allred = "".join(x if kk else "r" for x, kk in zip(cur_s, keep))
        a.target = best
        a.queue = [(allred, self.all_red)] if self.all_red > 0 else []
        ls.trafficlight.setRedYellowGreenState(a.tid, amber)
        a.until = now + self.amber

    def tick(self):
        """Call after every simulationStep(): advances amber/all-red transitions."""
        ls, now = self.ls, self.ls.simulation.getTime()
        self._refresh()
        for a in self.agents.values():
            if a.until is not None and now >= a.until:
                if a.queue:
                    state, dur = a.queue.pop(0)
                    ls.trafficlight.setRedYellowGreenState(a.tid, state)
                    a.until = now + dur
                else:
                    ls.trafficlight.setProgram(a.tid, a.program)
                    ls.trafficlight.setPhase(a.tid, a.target)
                    ls.trafficlight.setPhaseDuration(a.tid, 1e6)
                    a.cur, a.since, a.until, a.target = a.target, now, None, None
