#!/usr/bin/env python3
"""Check the numpy forward pass (and so the on-device C# port) against the real JAX model.

    python tools/check_np_model.py --ckpt 0546_22750M.flax_model --obs obs.npz [--out ref.npz]

Needs jax + flax + ygo-agent's `ygoai` package importable (the training setup
has all three). obs.npz holds real observations recorded from the training
simulator (cards_, global_, actions_, h_actions_ stacked along axis 0).
Each observation is run with a zero and a random recurrent state.
Exits non-zero if any probability differs by more than --tol.
"""
from __future__ import annotations

import argparse
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "server"))
sys.path.insert(0, os.path.join(HERE, "..", "training"))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--obs", required=True)
    ap.add_argument("--tol", type=float, default=2e-4)
    ap.add_argument("--out", help="save JAX reference outputs here")
    a = ap.parse_args(argv)

    os.environ.setdefault("JAX_PLATFORMS", "cpu")
    import jax
    import jax.numpy as jnp
    import flax
    from ygoai.rl.jax.agent import RNNAgent
    import resize_ckpt as R
    from synapse_server.np_model import NumpyModel

    tree = R.load_checkpoint(a.ckpt)
    rows = tree["params"]["Encoder_0"]["Embed_0"]["embedding"].shape[0]
    agent = RNNAgent(num_layers=2, rnn_channels=512, use_history=True, rnn_type="lstm",
                     num_channels=128, film=True, noam=True, version=2, embedding_shape=rows - 1)
    data = dict(np.load(a.obs))
    keys = ["cards_", "global_", "actions_", "h_actions_"]
    n = len(data["cards_"])
    sample = {k: jnp.array(data[k][:1]) for k in keys}
    z = np.zeros((1, 512), np.float32)
    params = agent.init(jax.random.PRNGKey(0), sample, (z, z))
    params = flax.serialization.from_state_dict(flax.core.unfreeze(params), {"params": tree["params"]})

    @jax.jit
    def fn(params, rstate, obs):
        rs, logits, value = agent.apply(params, obs, rstate)[:3]
        return rs, jax.nn.softmax(logits, -1), value

    npm = NumpyModel(tree)
    rng = np.random.default_rng(0)
    worst_p = worst_v = worst_h = 0.0
    agree = total = 0
    ref = {"probs": [], "value": [], "c": [], "h": [], "rc": [], "rh": []}
    for i in range(n):
        obs1 = {k: data[k][i] for k in keys}
        for mode in ("zero", "random"):
            if mode == "zero":
                c0 = h0 = np.zeros(512, np.float32)
            else:
                c0 = rng.normal(0, 0.5, 512).astype(np.float32)
                h0 = np.tanh(rng.normal(0, 0.5, 512)).astype(np.float32)
            (jc, jh), jp, jv = fn(params, (c0[None], h0[None]),
                                  {k: jnp.array(v[None]) for k, v in obs1.items()})
            jp, jv = np.asarray(jp)[0], float(np.asarray(jv).reshape(-1)[0])
            (nc, nh), npb, nv = npm.forward((c0, h0), obs1)
            worst_p = max(worst_p, float(np.abs(jp - npb).max()))
            worst_v = max(worst_v, abs(jv - nv))
            worst_h = max(worst_h, float(np.abs(np.asarray(jh)[0] - nh).max()))
            valid = int((obs1["actions_"][:, 3] != 0).sum())
            if valid > 1:
                total += 1
                # same move, or a tie within float noise
                agree += int(jp[int(np.argmax(npb))] >= jp.max() - 1e-5)
            for k, v in (("probs", jp), ("value", jv), ("c", np.asarray(jc)[0]), ("h", np.asarray(jh)[0]),
                         ("rc", c0), ("rh", h0)):
                ref[k].append(v)
    print(f"observations: {n} x 2 recurrent states")
    print(f"max |prob diff|   : {worst_p:.2e}")
    print(f"max |value diff|  : {worst_v:.2e}")
    print(f"max |state diff|  : {worst_h:.2e}")
    print(f"same best move    : {agree}/{total}")
    if a.out:
        np.savez_compressed(a.out, **{k: np.asarray(v) for k, v in ref.items()})
    ok = worst_p <= a.tol and worst_v <= a.tol * 10 and agree == total
    print("NUMPY MODEL MATCHES JAX" if ok else "MISMATCH")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
