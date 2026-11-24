"""Small fully connected networks in NumPy, with backpropagation and Adam.

Signal-control policies are small (tens of inputs, a few dozen hidden units), so a plain NumPy network is
enough and keeps the app free of a deep-learning framework. Gradients are checked against finite
differences in the tests.
"""
import json
from pathlib import Path

import numpy as np


class MLP:
    """x -> [Linear -> ReLU] * len(hidden) -> Linear."""

    def __init__(self, n_in: int, hidden: list, n_out: int, rng: np.random.Generator, out_scale: float = 1.0):
        sizes = [n_in, *hidden, n_out]
        self.W, self.b = [], []
        for i, (a, c) in enumerate(zip(sizes[:-1], sizes[1:])):
            std = np.sqrt(2.0 / a) * (out_scale if i == len(sizes) - 2 else 1.0)    # He init; small last layer
            self.W.append(rng.normal(0.0, std, size=(a, c)))
            self.b.append(np.zeros(c))

    def params(self) -> list:
        return [*self.W, *self.b]

    def forward(self, x: np.ndarray):
        """Returns output and the activations needed for backward()."""
        acts = [x]
        h = x
        for i, (W, b) in enumerate(zip(self.W, self.b)):
            h = h @ W + b
            if i < len(self.W) - 1:
                h = np.maximum(h, 0.0)
            acts.append(h)
        return h, acts

    def __call__(self, x):
        return self.forward(x)[0]

    def backward(self, acts: list, dout: np.ndarray) -> list:
        """Gradients of the loss with respect to [W..., b...], given dLoss/dOutput."""
        gW, gb = [None] * len(self.W), [None] * len(self.b)
        g = dout
        for i in range(len(self.W) - 1, -1, -1):
            gW[i] = acts[i].T @ g
            gb[i] = g.sum(axis=0)
            if i > 0:
                g = (g @ self.W[i].T) * (acts[i] > 0)
        return [*gW, *gb]

    def copy_from(self, other: "MLP"):
        self.W = [w.copy() for w in other.W]
        self.b = [b.copy() for b in other.b]

    def state(self, prefix: str) -> dict:
        d = {f"{prefix}W{i}": w for i, w in enumerate(self.W)}
        d.update({f"{prefix}b{i}": b for i, b in enumerate(self.b)})
        return d

    def load(self, arrays, prefix: str):
        self.W = [np.asarray(arrays[f"{prefix}W{i}"]) for i in range(len(self.W))]
        self.b = [np.asarray(arrays[f"{prefix}b{i}"]) for i in range(len(self.b))]


class Adam:
    def __init__(self, params: list, lr: float, b1=0.9, b2=0.999, eps=1e-8, clip: float = 10.0):
        self.lr, self.b1, self.b2, self.eps, self.clip = lr, b1, b2, eps, clip
        self.m = [np.zeros_like(p) for p in params]
        self.v = [np.zeros_like(p) for p in params]
        self.t = 0

    def step(self, params: list, grads: list):
        """Update params in place. Gradients are clipped by global norm first."""
        norm = np.sqrt(sum(float((g * g).sum()) for g in grads))
        scale = min(1.0, self.clip / (norm + 1e-12))
        self.t += 1
        for p, g, m, v in zip(params, grads, self.m, self.v):
            g = g * scale
            m *= self.b1
            m += (1 - self.b1) * g
            v *= self.b2
            v += (1 - self.b2) * g * g
            mh = m / (1 - self.b1 ** self.t)
            vh = v / (1 - self.b2 ** self.t)
            p -= self.lr * mh / (np.sqrt(vh) + self.eps)
        return norm


def save(path: Path, arrays: dict, meta: dict):
    np.savez(path, __meta__=np.array(json.dumps(meta)), **arrays)


def load(path: Path):
    z = np.load(path, allow_pickle=False)
    meta = json.loads(str(z["__meta__"]))
    return {k: z[k] for k in z.files if k != "__meta__"}, meta
