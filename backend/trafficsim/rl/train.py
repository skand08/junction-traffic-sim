"""Training jobs: configuration, the episode loop (in its own process), and the store of trained agents.

Each agent is stored under "research/agents/<id>/" (store.py):
  config.json     document: everything needed to train it again (scenario, algorithm, hyperparameters, seeds)
  manifest.json   document: software versions, network file hash, seeds used per episode
  status.json     document: state and progress (also the list of checkpoints)
  log.jsonl       log: one row per episode: reward, travel time, throughput, teleports, loss, exploration
  ckpt/ep_NNNN.npz, best.npz, final.npz   files: network weights (+ the metadata needed to use them),
                  under WORKSPACE/research/agents/<id>/ and mirrored to the file store
With JUNCTION_EXECUTION=queue the API records and queues a training; a worker runs it (worker.py).
"""
import hashlib
import os
import multiprocessing as mp
import threading
import time
import uuid
from pathlib import Path
from typing import List, Literal, Optional

import numpy as np
from pydantic import BaseModel, Field

from .. import config, jobqueue, store

AGENTS_DIR = config.WORKSPACE_DIR / "research" / "agents"
DOCS = "research/agents"
MAX_TRAININGS = int(os.environ.get("JUNCTION_MAX_TRAININGS", "2"))    # at once, across all workers


class ObsCfg(BaseModel):
    reach_m: float = Field(60, ge=10, le=300)
    features: List[Literal["queue", "approaching", "out_queue", "phase", "elapsed"]] = ["queue", "approaching", "out_queue", "phase", "elapsed"]


class ActCfg(BaseModel):
    delta_t: int = Field(5, ge=2, le=30)          # seconds between decisions
    min_green: float = Field(10, ge=5, le=60)
    amber: float = Field(3, ge=2, le=6)
    all_red: float = Field(2, ge=0, le=5)


class TrainCfg(BaseModel):
    episodes: int = Field(30, ge=1, le=2000)
    episode_min: int = Field(30, ge=5, le=60)      # minutes of new traffic per episode
    demand_scales: List[float] = [0.8, 1.0, 1.2]   # an episode's demand is drawn from these (robust training)
    seed: int = Field(1, ge=1, le=1_000_000)
    checkpoint_every: int = Field(5, ge=1, le=500)
    # evaluation: every N episodes, run the greedy policy (no exploration, no learning) on fixed held-out traffic;
    # gives a clean convergence curve and picks the best model on the same traffic every time. 0 = off
    eval_every: int = Field(5, ge=0, le=100)
    eval_episodes: int = Field(1, ge=1, le=5)
    eval_demand: float = Field(1.0, ge=0.3, le=2.0)
    early_stop_patience: int = Field(0, ge=0, le=50)   # stop after this many evaluations without improvement; 0 = off


class Hyper(BaseModel):
    lr: float = Field(1e-3, gt=0, le=0.1)
    lr_schedule: Literal["constant", "linear"] = "constant"   # linear: falls to 10% of lr by the last episode
    gamma: float = Field(0.95, ge=0, le=0.999)
    hidden: List[int] = [64, 64]
    # DQN / Double DQN
    batch: int = Field(64, ge=8, le=1024)
    buffer: int = Field(50_000, ge=1000, le=1_000_000)
    learning_starts: int = Field(500, ge=0)
    target_update: int = Field(500, ge=10)
    eps_start: float = Field(1.0, ge=0, le=1)
    eps_end: float = Field(0.05, ge=0, le=1)
    eps_decay_frac: float = Field(0.6, gt=0, le=1)  # share of training over which exploration falls
    # PPO
    clip: float = Field(0.2, gt=0, le=0.5)
    epochs: int = Field(4, ge=1, le=20)
    minibatch: int = Field(256, ge=16)
    gae_lambda: float = Field(0.95, ge=0, le=1)
    ent_coef: float = Field(0.01, ge=0, le=0.2)
    vf_coef: float = Field(0.5, ge=0, le=2)


class AgentCfg(BaseModel):
    name: str = "Agent"
    scenario_id: str
    algorithm: Literal["dqn", "double_dqn", "ppo"] = "dqn"
    sharing: Literal["shared", "independent"] = "shared"
    observation: ObsCfg = ObsCfg()
    action: ActCfg = ActCfg()
    reward: Literal["pressure", "queue", "waiting"] = "pressure"
    training: TrainCfg = TrainCfg()
    hyper: Hyper = Hyper()
    parent_id: Optional[str] = None                # set for an ablation variant of another agent
    note: str = ""


def _sha(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


# ---------- the training process ----------

def run_episode(ls, env, learners, cfg: dict, train: bool, eps: float, rng, ep_end: float):
    """Run SUMO to ep_end with the agents in control. Returns per-episode measurements."""
    from .agents import PPO
    hp = cfg["hyper"]
    pending = {}                                      # tid -> (obs, action, mask, extra)
    seqs = {tid: [] for tid in env.ids}
    rewards, losses = [], []
    departs, tts = {}, []
    halting_sum, halting_n = 0, 0
    teleports = 0
    while ls.simulation.getTime() < ep_end:
        ls.simulationStep()
        env.tick()
        t = ls.simulation.getTime()
        for v in ls.simulation.getDepartedIDList():
            departs[v] = t
        for v in ls.simulation.getArrivedIDList():
            if v in departs:
                tts.append(t - departs.pop(v))
        teleports += ls.simulation.getStartingTeleportNumber()
        if int(t) % env.delta_t:
            continue
        halting_sum += sum(ls.vehicle.getSpeed(v) < 0.1 for v in ls.vehicle.getIDList())
        halting_n += 1
        last = t + env.delta_t >= ep_end
        for tid in env.ids:
            if not env.ready(tid) and not last:
                continue
            o, m = env.observe(tid), env.mask(tid)
            lrn = learners.of[tid]
            if tid in pending:                        # close the previous decision with the reward it earned
                po, pa, pm, extra = pending.pop(tid)
                r = env.reward(tid)
                rewards.append(r)
                if train:
                    if isinstance(lrn, PPO):
                        seqs[tid].append((po, pm, pa, extra[0], r, extra[1]))
                    else:
                        lrn.store(po, pa, r, o, m, last)
                        for _ in range(int(hp.get("train_every", 1))):
                            l = lrn.learn()
                            if l is not None:
                                losses.append(l)
            if last or not env.ready(tid):
                continue
            if isinstance(lrn, PPO):
                a, logp, val = lrn.act(o, m, greedy=not train)
                extra = (logp, val)
            else:
                a = lrn.act(o, m, eps if train else 0.0)
                extra = None
            env.act(tid, a)
            pending[tid] = (o, a, m, extra)
    if train and learners.algorithm == "ppo":
        groups = {}
        for tid, s in seqs.items():
            groups.setdefault(id(learners.of[tid]), (learners.of[tid], []))[1].append(s)
        for lrn, ss in groups.values():
            l = lrn.learn(ss)
            if l is not None:
                losses.append(l)
    return dict(reward=float(np.mean(rewards)) if rewards else 0.0, decisions=len(rewards),
                reward_sum=float(np.sum(rewards)) / max(1, len(env.ids)),
                travel_time_s=float(np.mean(tts)) if tts else None, arrived=len(tts),
                mean_stopped=halting_sum / halting_n if halting_n else 0.0, teleports=teleports,
                loss=float(np.mean(losses)) if losses else None)


def _sumo_args(job: dict, routes: str, scale: float, seed: int, stop: float) -> list:
    from ..runner import JUNCTION_BLOCKER_S, TELEPORT_S
    return ["sumo", "-n", job["net_file"], "-r", routes, "--begin", str(job["begin"]), "--end", str(stop),
            "--scale", str(scale), "--seed", str(seed), "--step-length", str(config.STEP_LENGTH),
            "--time-to-teleport", str(TELEPORT_S), "--ignore-route-errors", "true",
            "--ignore-junction-blocker", str(JUNCTION_BLOCKER_S), "--no-step-log", "true", "--no-warnings", "true"]


EVAL_SEED = 900_000


def _set_lr(learners, lr: float):
    for lrn in learners.unique.values():
        for name in ("opt", "opt_pi", "opt_v"):
            if hasattr(lrn, name):
                getattr(lrn, name).lr = lr


def _evaluate(ls, job: dict, cfg: dict, learners, reach_cache: dict) -> dict:
    """Greedy policy, no learning, on the same held-out traffic every time (seeds EVAL_SEED + i)."""
    from .env import SignalEnv
    tr = cfg["training"]
    ep_end = job["begin"] + tr["episode_min"] * 60
    out = []
    for i in range(int(tr.get("eval_episodes") or 1)):
        ls.start(_sumo_args(job, job["routes"], float(tr.get("eval_demand") or 1.0), EVAL_SEED + i, ep_end + 1))
        try:
            env = SignalEnv(ls, job["net_file"], cfg, reach_cache)
            out.append(run_episode(ls, env, learners, cfg, False, 0.0, None, ep_end))
        finally:
            ls.close()
    tts = [o["travel_time_s"] for o in out if o["travel_time_s"] is not None]
    return dict(travel_time_s=round(float(np.mean(tts)), 2) if tts else None,
                reward=round(float(np.mean([o["reward"] for o in out])), 4), arrived=int(sum(o["arrived"] for o in out)))


def _alive(pid) -> bool:
    if not pid:
        return False
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError):
        return False


def _write_status(d: Path, **kw):
    store.docs.merge(f"{DOCS}/{d.name}/status.json", **kw)


def _saved(d: Path, *files: Path):
    """Mirror new model files to the file store and list what exists, so another machine can find them."""
    for f in files:
        store.files.push(f)
    ck = sorted(f.name for f in (d / "ckpt").glob("*.npz")) if (d / "ckpt").exists() else []
    _write_status(d, checkpoints=ck, has_model=(d / "final.npz").exists(), has_best=(d / "best.npz").exists())


def prepare(cfg: "AgentCfg", d: Path) -> dict:
    """Build the scenario's network for training (fixed timing: the agent replaces the signal plans)."""
    from .. import build, scenario as sc
    s = sc.load(cfg.scenario_id)
    b = build.build(s.model_copy(update=dict(controller="fixed")), d / "build")
    return dict(net_file=str(b.net_file), routes=str(b.demand_file), begin=b.begin, network=s.base_network,
                scenario_name=s.name, net_sha=_sha(str(b.net_file)))


def train_worker(job: dict, conn):
    """The training process: episodes until done or stopped; pause holds between episodes."""
    import libsumo as ls
    from .agents import Learners
    from .env import SignalEnv
    from .nn import save
    d = Path(job["dir"])
    cfg = job["cfg"]
    tr, hp = cfg["training"], cfg["hyper"]
    rng = np.random.default_rng(tr["seed"])
    paused, stop = False, False
    learners = None
    best = -1e18
    reach_cache: dict = {}
    total_decisions_est = None
    seen_decisions = 0
    start_ep = job.get("start_episode", 0)
    eval_best, since_best, stop_reason = None, 0, None
    _write_status(d, pid=os.getpid())
    eval_every = int(tr.get("eval_every") or 0)
    try:
        for ep in range(start_ep, tr["episodes"]):
            while True:                                  # commands between episodes
                while conn.poll():
                    c = conn.recv().get("action")
                    if c == "stop":
                        stop = True
                    elif c == "pause":
                        paused = True
                    elif c == "resume":
                        paused = False
                if stop or not paused:
                    break
                _write_status(d, state="paused")
                time.sleep(0.3)
            if stop:
                break
            _write_status(d, state="running", episode=ep)
            scale = float(rng.choice(tr["demand_scales"]))
            seed = tr["seed"] * 1000 + ep
            ep_end = job["begin"] + tr["episode_min"] * 60
            t0 = time.time()
            ls.start(_sumo_args(job, job["routes"], scale, seed, ep_end + 1))
            try:
                env = SignalEnv(ls, job["net_file"], cfg, reach_cache)
                if learners is None:
                    learners = Learners(cfg["algorithm"], cfg["sharing"], env.ids, env.obs_size(), env.n_phases, hp, tr["seed"])
                    if job.get("resume_from"):
                        from .nn import load
                        arrays, _ = load(Path(job["resume_from"]))
                        learners.load(arrays)
                    meta = dict(algorithm=cfg["algorithm"], sharing=cfg["sharing"], ids=env.ids, n_obs=env.obs_size(),
                                n_act=env.n_phases, observation=cfg["observation"], action=cfg["action"], reward=cfg["reward"],
                                hidden=hp["hidden"], network=job["network"], net_sha=job["net_sha"])
                    _write_status(d, agents=len(env.ids), n_obs=env.obs_size(), n_act=env.n_phases)
                # exploration falls linearly over eps_decay_frac of all decisions (estimated from the first episode)
                if total_decisions_est:
                    frac = min(1.0, seen_decisions / (hp["eps_decay_frac"] * total_decisions_est))
                else:
                    frac = 0.0
                eps = hp["eps_start"] + (hp["eps_end"] - hp["eps_start"]) * frac
                if hp.get("lr_schedule") == "linear":
                    _set_lr(learners, hp["lr"] * (1 - 0.9 * ep / max(1, tr["episodes"] - 1)))
                m = run_episode(ls, env, learners, cfg, True, eps, rng, ep_end)
            finally:
                ls.close()
            seen_decisions += m["decisions"]
            if total_decisions_est is None and m["decisions"]:
                total_decisions_est = m["decisions"] * tr["episodes"]
            first = next(iter(learners.unique.values()))
            row = dict(episode=ep + 1, demand_scale=scale, seed=seed, wall_s=round(time.time() - t0, 1),
                       epsilon=round(eps, 4) if cfg["algorithm"] != "ppo" else None,
                       entropy=getattr(first, "last_entropy", None), **m)
            if hp.get("lr_schedule") == "linear":
                row["lr"] = round(hp["lr"] * (1 - 0.9 * ep / max(1, tr["episodes"] - 1)), 8)
            evaluated = eval_every and ((ep + 1) % eval_every == 0 or ep + 1 == tr["episodes"])
            if evaluated:
                _write_status(d, state="evaluating", episode=ep)
                ev = _evaluate(ls, job, cfg, learners, reach_cache)
                row.update(eval_travel_time_s=ev["travel_time_s"], eval_reward=ev["reward"], eval_arrived=ev["arrived"])
            store.logs.append(f"{DOCS}/{d.name}/log.jsonl", row)
            arrays = learners.state()
            new_files = [d / "final.npz"]
            ck = (ep + 1) % tr["checkpoint_every"] == 0 or ep + 1 == tr["episodes"]
            if ck:
                (d / "ckpt").mkdir(exist_ok=True)
                save(d / "ckpt" / f"ep_{ep + 1:04d}.npz", arrays, dict(meta, episode=ep + 1))
                new_files.append(d / "ckpt" / f"ep_{ep + 1:04d}.npz")
            if eval_every:                                # best = lowest travel time on the fixed evaluation traffic
                if evaluated and row["eval_travel_time_s"] is not None and (eval_best is None or row["eval_travel_time_s"] < eval_best):
                    eval_best, since_best = row["eval_travel_time_s"], 0
                    save(d / "best.npz", arrays, dict(meta, episode=ep + 1, eval_travel_time_s=eval_best))
                    new_files.append(d / "best.npz")
                    _write_status(d, best_episode=ep + 1, best_eval_travel_time_s=round(eval_best, 2))
                elif evaluated:
                    since_best += 1
            elif m["reward_sum"] > best:
                best = m["reward_sum"]
                save(d / "best.npz", arrays, dict(meta, episode=ep + 1))
                new_files.append(d / "best.npz")
                _write_status(d, best_episode=ep + 1)
            save(d / "final.npz", arrays, dict(meta, episode=ep + 1))
            _saved(d, *new_files)
            _write_status(d, episodes_done=ep + 1)
            conn.send(dict(kind="episode", row=row))
            patience = int(tr.get("early_stop_patience") or 0)
            if eval_every and patience and since_best >= patience:
                stop_reason = f"Stopped early: no improvement in {patience} evaluations."
                break
        _write_status(d, state="stopped" if stop else "done", finished=time.time(), **({"note": stop_reason} if stop_reason else {}))
        conn.send(dict(kind="end", state="stopped" if stop else "done"))
    except Exception as e:  # noqa: BLE001
        import traceback
        _write_status(d, state="failed", error=f"{type(e).__name__}: {e}", trace=traceback.format_exc()[-3000:])
        try:
            conn.send(dict(kind="end", state="failed"))
        except Exception:  # noqa: BLE001
            pass


class TrainingManager:
    """Runs training jobs (one process each); their state is kept in the store."""

    def __init__(self, max_jobs: int = MAX_TRAININGS):
        self.procs: dict = {}
        self.conns: dict = {}
        self.lock = threading.Lock()
        self.max_jobs = max_jobs
        if not store.SHARED:                       # one machine: jobs cut off by a server restart
            for aid, docs in store.docs.group(DOCS).items():
                st = docs.get("status.json") or {}
                if st.get("state") in ("running", "paused", "queued", "evaluating") and not _alive(st.get("pid")):
                    _write_status(AGENTS_DIR / aid, state="interrupted")

    def _active(self) -> int:
        if jobqueue.remote():
            return len(jobqueue.active("train"))
        with self.lock:
            return sum(p.is_alive() for p in self.procs.values())

    def create(self, cfg: AgentCfg) -> dict:
        """Record a training and start it (here, or on a worker). Raises build.EditError for invalid scenarios."""
        n = self._active()
        if n >= self.max_jobs:
            raise RuntimeError(f"{n} trainings are already running; wait for one to finish or stop it.")
        aid = uuid.uuid4().hex[:10]
        d = AGENTS_DIR / aid
        d.mkdir(parents=True)
        job = prepare(cfg, d)                       # also checks the scenario; a worker builds the same network again
        from ..jobs import versions
        store.docs.write(f"{DOCS}/{aid}/config.json", cfg.model_dump(mode="json"))
        manifest = dict(id=aid, created=time.time(), versions=versions(), network=job["network"],
                        net_sha=job["net_sha"], scenario_id=cfg.scenario_id, scenario_name=job.get("scenario_name"),
                        episode_seeds=[cfg.training.seed * 1000 + e for e in range(cfg.training.episodes)],
                        demand_seed=cfg.training.seed, numerics="NumPy MLP, Adam; float64")
        store.docs.write(f"{DOCS}/{aid}/manifest.json", manifest)
        _write_status(d, state="queued", episode=0, episodes_done=0, episodes=cfg.training.episodes, created=time.time(),
                      checkpoints=[], has_model=False, has_best=False)
        if jobqueue.remote():
            jobqueue.enqueue("train", aid, {})
        else:
            self._start(aid, dict(job, dir=str(d), cfg=cfg.model_dump()))
        return self.info(aid)

    def launch(self, aid: str, payload: Optional[dict] = None):
        """Start a recorded training in this process (a worker)."""
        d = AGENTS_DIR / aid
        d.mkdir(parents=True, exist_ok=True)
        cfg = AgentCfg(**store.docs.read(f"{DOCS}/{aid}/config.json"))
        job = prepare(cfg, d)
        self._start(aid, dict(job, dir=str(d), cfg=cfg.model_dump()))

    def running(self, aid: str) -> bool:
        p = self.procs.get(aid)
        return bool(p and p.is_alive())

    def _start(self, aid, job):
        ctx = mp.get_context("spawn")
        parent, child = ctx.Pipe()
        p = ctx.Process(target=train_worker, args=(job, child), daemon=True)
        p.start()
        child.close()
        with self.lock:
            self.procs[aid], self.conns[aid] = p, parent
        threading.Thread(target=self._drain, args=(aid, parent), daemon=True).start()

    def _drain(self, aid, conn):
        while True:
            try:
                conn.recv()
            except (EOFError, OSError):
                break

    def control(self, aid: str, action: str):
        d = AGENTS_DIR / aid
        conn = self.conns.get(aid)
        p = self.procs.get(aid)
        if not (conn and p and p.is_alive()):
            if not jobqueue.remote():
                raise KeyError(f"training '{aid}' is not running")
            if action == "stop" and jobqueue.cancel_queued(aid):
                _write_status(d, state="stopped", finished=time.time())
                return
            if not jobqueue.command(aid, dict(action=action)):
                raise KeyError(f"training '{aid}' is not running")
        else:
            conn.send(dict(action=action))
        if action == "pause":
            _write_status(d, state="pausing")
        if action == "stop":
            _write_status(d, state="stopping")

    @staticmethod
    def _info(aid: str, docs: dict, local: bool, alive: bool) -> dict:
        st = dict(docs["status.json"])
        if local and st.get("state") in ("running", "paused", "queued", "pausing", "stopping") and not alive:
            st["state"] = "interrupted"
        d = AGENTS_DIR / aid
        ckpts = st.get("checkpoints")
        if ckpts is None:                            # agents trained before checkpoints were listed in the status
            ckpts = sorted(f.name for f in (d / "ckpt").glob("*.npz")) if (d / "ckpt").exists() else []
        return dict(id=aid, config=docs["config.json"], manifest=docs["manifest.json"], status=st, checkpoints=ckpts,
                    has_model=st.get("has_model", (d / "final.npz").exists()), has_best=st.get("has_best", (d / "best.npz").exists()))

    def info(self, aid: str) -> dict:
        if "/" in aid:
            raise KeyError(f"agent '{aid}' not found")
        docs = {n: store.docs.read(f"{DOCS}/{aid}/{n}") for n in ("config.json", "manifest.json", "status.json")}
        if any(v is None for v in docs.values()):
            raise KeyError(f"agent '{aid}' not found")
        return self._info(aid, docs, not store.SHARED, self.running(aid))

    def log(self, aid: str) -> list:
        return store.logs.rows(f"{DOCS}/{aid}/log.jsonl")

    def list(self) -> list:
        out = []
        for aid, docs in store.docs.group(DOCS).items():
            if all(n in docs for n in ("config.json", "manifest.json", "status.json")):
                out.append(self._info(aid, docs, not store.SHARED, self.running(aid)))
        return sorted(out, key=lambda a: a["manifest"].get("created") or 0, reverse=True)

    def delete(self, aid: str):
        if self.running(aid) or (jobqueue.remote() and aid in jobqueue.active("train")):
            raise RuntimeError("Stop the training before deleting it.")
        store.docs.delete_prefix(f"{DOCS}/{aid}")
        store.logs.delete(f"{DOCS}/{aid}/log.jsonl")
        store.files.remove(AGENTS_DIR / aid)

    def model_path(self, aid: str, which: str = "final") -> Path:
        d = AGENTS_DIR / aid
        f = d / f"{which}.npz" if which in ("final", "best") else d / "ckpt" / which
        if "/" in aid or "/" in which or not store.files.pull(f, fresh=which in ("final", "best")):
            raise KeyError(f"model '{aid}/{which}' not found")
        return f

    def stop_all(self):
        for aid, p in list(self.procs.items()):
            if p.is_alive():
                try:
                    self.conns[aid].send(dict(action="stop"))
                except Exception:  # noqa: BLE001
                    pass
                p.join(timeout=2)
                if p.is_alive():
                    p.terminate()
