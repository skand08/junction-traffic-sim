"""Learning algorithms: DQN, Double DQN and PPO, with one network shared by all signals or one per signal.

Invalid actions (phase slots a junction does not have) are masked everywhere: they are never chosen, never
used as a bootstrap target, and get zero probability under PPO.
"""
import numpy as np

from .nn import MLP, Adam

NEG = -1e9


def _masked(q: np.ndarray, mask: np.ndarray) -> np.ndarray:
    return np.where(mask, q, NEG)


class DQN:
    """Deep Q-learning with experience replay and a target network. double=True uses the online network to
    pick the next action and the target network to value it (van Hasselt et al. 2016)."""

    def __init__(self, n_obs, n_act, hp: dict, rng: np.random.Generator, double: bool = False):
        self.n_act, self.hp, self.rng, self.double = n_act, hp, rng, double
        self.q = MLP(n_obs, hp["hidden"], n_act, rng, out_scale=0.1)
        self.target = MLP(n_obs, hp["hidden"], n_act, rng)
        self.target.copy_from(self.q)
        self.opt = Adam(self.q.params(), hp["lr"])
        cap = int(hp["buffer"])
        self.buf = dict(o=np.zeros((cap, n_obs)), a=np.zeros(cap, int), r=np.zeros(cap), o2=np.zeros((cap, n_obs)),
                        m2=np.zeros((cap, n_act), bool), d=np.zeros(cap))
        self.cap, self.n, self.i = cap, 0, 0
        self.updates = 0
        self.last_loss = None

    def values(self, obs: np.ndarray, mask: np.ndarray) -> np.ndarray:
        return _masked(self.q(obs[None])[0], mask)

    def act(self, obs, mask, eps: float) -> int:
        if self.rng.random() < eps:
            return int(self.rng.choice(np.flatnonzero(mask)))
        return int(np.argmax(self.values(obs, mask)))

    def store(self, o, a, r, o2, m2, done):
        b, i = self.buf, self.i
        b["o"][i], b["a"][i], b["r"][i], b["o2"][i], b["m2"][i], b["d"][i] = o, a, r, o2, m2, float(done)
        self.i = (i + 1) % self.cap
        self.n = min(self.n + 1, self.cap)

    def learn(self):
        hp = self.hp
        if self.n < max(hp["batch"], hp.get("learning_starts", 500)):
            return None
        idx = self.rng.integers(0, self.n, size=hp["batch"])
        b = {k: v[idx] for k, v in self.buf.items()}
        q2_t = _masked(self.target(b["o2"]), b["m2"])
        if self.double:
            a2 = np.argmax(_masked(self.q(b["o2"]), b["m2"]), axis=1)
            nxt = q2_t[np.arange(len(a2)), a2]
        else:
            nxt = q2_t.max(axis=1)
        y = b["r"] + hp["gamma"] * (1.0 - b["d"]) * nxt
        q, acts = self.q.forward(b["o"])
        qa = q[np.arange(len(idx)), b["a"]]
        err = qa - y
        # Huber loss (delta 1), averaged over the batch
        g = np.clip(err, -1.0, 1.0) / len(idx)
        dout = np.zeros_like(q)
        dout[np.arange(len(idx)), b["a"]] = g
        self.opt.step(self.q.params(), self.q.backward(acts, dout))
        self.updates += 1
        if self.updates % int(hp["target_update"]) == 0:
            self.target.copy_from(self.q)
        self.last_loss = float(np.mean(np.where(np.abs(err) < 1, 0.5 * err ** 2, np.abs(err) - 0.5)))
        return self.last_loss

    def state(self, prefix=""):
        return self.q.state(prefix + "q_")

    def load(self, arrays, prefix=""):
        self.q.load(arrays, prefix + "q_")
        self.target.copy_from(self.q)


def _softmax(z, mask):
    z = np.where(mask, z, NEG)
    z = z - z.max(axis=-1, keepdims=True)
    e = np.exp(z) * mask
    return e / e.sum(axis=-1, keepdims=True)


class PPO:
    """Proximal Policy Optimisation (Schulman et al. 2017): clipped surrogate objective, generalised advantage
    estimation, an entropy bonus, and a separate value network."""

    def __init__(self, n_obs, n_act, hp: dict, rng: np.random.Generator):
        self.n_act, self.hp, self.rng = n_act, hp, rng
        self.pi = MLP(n_obs, hp["hidden"], n_act, rng, out_scale=0.01)
        self.v = MLP(n_obs, hp["hidden"], 1, rng)
        self.opt_pi = Adam(self.pi.params(), hp["lr"])
        self.opt_v = Adam(self.v.params(), hp["lr"])
        self.traj = []                       # (o, mask, a, logp, r, v, done) per decision, per agent sequence
        self.last_loss = None
        self.last_entropy = None

    def probs(self, obs, mask):
        return _softmax(self.pi(obs[None])[0], mask)

    def values(self, obs, mask):
        return self.probs(obs, mask)

    def act(self, obs, mask, greedy=False):
        p = self.probs(obs, mask)
        a = int(np.argmax(p)) if greedy else int(self.rng.choice(len(p), p=p))
        return a, float(np.log(p[a] + 1e-12)), float(self.v(obs[None])[0, 0])

    def learn(self, seqs: list):
        """seqs: per agent, a list of (o, mask, a, logp, r, v) in time order; the last step ends the episode."""
        hp = self.hp
        O, M, A, LP, ADV, RET = [], [], [], [], [], []
        for seq in seqs:
            if not seq:
                continue
            r = np.array([s[4] for s in seq])
            v = np.array([s[5] for s in seq] + [0.0])
            adv = np.zeros(len(seq))
            gae = 0.0
            for t in range(len(seq) - 1, -1, -1):
                delta = r[t] + hp["gamma"] * v[t + 1] - v[t]
                gae = delta + hp["gamma"] * hp["gae_lambda"] * gae
                adv[t] = gae
            O += [s[0] for s in seq]; M += [s[1] for s in seq]; A += [s[2] for s in seq]; LP += [s[3] for s in seq]
            ADV += list(adv); RET += list(adv + v[:-1])
        if not O:
            return None
        O, M, A, LP = np.array(O), np.array(M), np.array(A), np.array(LP)
        ADV, RET = np.array(ADV), np.array(RET)
        ADV = (ADV - ADV.mean()) / (ADV.std() + 1e-8)
        n, mb = len(O), int(hp["minibatch"])
        losses, ents = [], []
        for _ in range(int(hp["epochs"])):
            order = self.rng.permutation(n)
            for s in range(0, n, mb):
                j = order[s:s + mb]
                o, m, a, lp, ad, ret = O[j], M[j], A[j], LP[j], ADV[j], RET[j]
                z, acts = self.pi.forward(o)
                p = _softmax(z, m)
                logp = np.log(p[np.arange(len(j)), a] + 1e-12)
                ratio = np.exp(logp - lp)
                clipped = np.clip(ratio, 1 - hp["clip"], 1 + hp["clip"])
                use = (ratio * ad) <= (clipped * ad)              # the unclipped term is the minimum: it carries gradient
                dlogp = np.where(use, -ratio * ad, 0.0) / len(j)  # d(-min(...))/d logp
                onehot = np.zeros_like(p); onehot[np.arange(len(j)), a] = 1.0
                g = dlogp[:, None] * (onehot - p)
                logp_all = np.where(p > 0, np.log(np.where(p > 0, p, 1.0)), 0.0)
                H = -(p * logp_all).sum(axis=1)
                g += hp["ent_coef"] * p * (logp_all + H[:, None]) / len(j)   # gradient of -ent_coef * H
                g *= m
                self.opt_pi.step(self.pi.params(), self.pi.backward(acts, g))
                vv, vacts = self.v.forward(o)
                dv = hp["vf_coef"] * 2 * (vv[:, 0] - ret)[:, None] / len(j)
                self.opt_v.step(self.v.params(), self.v.backward(vacts, dv))
                losses.append(float(-np.minimum(ratio * ad, clipped * ad).mean()))
                ents.append(float(H.mean()))
        self.last_loss, self.last_entropy = float(np.mean(losses)), float(np.mean(ents))
        return self.last_loss

    def state(self, prefix=""):
        return {**self.pi.state(prefix + "pi_"), **self.v.state(prefix + "v_")}

    def load(self, arrays, prefix=""):
        self.pi.load(arrays, prefix + "pi_")
        self.v.load(arrays, prefix + "v_")


class Learners:
    """One learner shared by every signal, or one per signal (independent learners)."""

    def __init__(self, algorithm: str, sharing: str, ids: list, n_obs: int, n_act: int, hp: dict, seed: int):
        self.algorithm, self.sharing, self.ids = algorithm, sharing, ids
        rng = np.random.default_rng(seed)

        def make():
            if algorithm == "ppo":
                return PPO(n_obs, n_act, hp, rng)
            return DQN(n_obs, n_act, hp, rng, double=(algorithm == "double_dqn"))
        if sharing == "shared":
            one = make()
            self.of = {i: one for i in ids}
            self.unique = {"shared": one}
        else:
            self.unique = {i: make() for i in ids}
            self.of = dict(self.unique)

    def state(self) -> dict:
        out = {}
        for k, l in self.unique.items():
            out.update(l.state(prefix=f"{k}__"))
        return out

    def load(self, arrays):
        for k, l in self.unique.items():
            l.load(arrays, prefix=f"{k}__")
