"""Dependency-light forward pass of the ygo-agent RNNAgent (numpy only).

Mirrors ygoai.rl.jax.agent.RNNAgent with the configuration Synapse uses
(version=2, num_layers=2, num_channels=128, rnn lstm 512, film, noam,
use_history, action_feats, card_mask=False, oppo_info=False) for a single
observation. It is the reference for the on-device C# port
(windbot/.../Synapse/SynapseModel.cs) and is checked against the real JAX
model by tools/check_np_model.py.

Parameters come straight from the flax checkpoint (msgpack tree).
"""
from __future__ import annotations

from typing import Dict, Tuple

import numpy as np

F32 = np.float32
BIG_NEG = np.finfo(np.float32).min


def _bin_params(x_max=12000, n_bins=32, sig_bins=24):
    p1 = np.linspace(0, 8000, sig_bins + 1, dtype=F32)[1:]
    p2 = np.linspace(8000, x_max, n_bins - sig_bins + 1, dtype=F32)[1:]
    points = np.concatenate([p1, p2]).astype(F32)
    intervals = np.concatenate([points[0:1], points[1:] - points[:-1]]).astype(F32)
    return points, intervals


BIN_POINTS, BIN_INTERVALS = _bin_params()


def leaky(x):
    return np.where(x >= 0, x, F32(0.1) * x).astype(F32)


def silu(x):
    return (x / (F32(1) + np.exp(-x))).astype(F32)


def sigmoid(x):
    return (F32(1) / (F32(1) + np.exp(-x))).astype(F32)


def layer_norm(x, p, eps=1e-6):
    mean = x.mean(-1, keepdims=True)
    var = np.maximum((x * x).mean(-1, keepdims=True) - mean * mean, 0)  # flax fast variance
    return ((x - mean) / np.sqrt(var + F32(eps)) * p["scale"] + p["bias"]).astype(F32)


def rms_norm(x, p, eps=1e-6):
    return (x / np.sqrt((x * x).mean(-1, keepdims=True) + F32(eps)) * p["scale"]).astype(F32)


def decode_id(x):
    x = x.astype(np.int64)
    return x[..., 0] * 256 + x[..., 1]


def num_transform(x2, mlp_p):
    v = decode_id(x2).astype(F32)[..., None]
    b = np.clip((v - BIN_POINTS + BIN_INTERVALS) / BIN_INTERVALS, 0, 1).astype(F32)
    return leaky(b @ mlp_p["Dense_0"]["kernel"])


def glu(x, p):
    g = silu(x @ p["gate"]["kernel"])
    return ((g * (x @ p["up"]["kernel"])) @ p["down"]["kernel"]).astype(F32)


def _rope_tables(head_dim, n):
    freqs = 1.0 / (10000.0 ** (np.arange(0, head_dim, 2, dtype=F32)[: head_dim // 2] / head_dim))
    t = np.arange(n, dtype=F32)
    f = np.outer(t, freqs).astype(F32)
    f = np.concatenate([f, f], -1)
    return np.cos(f).astype(F32), np.sin(f).astype(F32)


def _rotate_half(x):
    h = x.shape[-1] // 2
    return np.concatenate([-x[..., h:], x[..., :h]], -1)


def attention(x, p, key_mask=None, rope_n=None):
    """x (L, C); kernels query/key/value (C, H, D), out (H, D, C)."""
    q = np.einsum("lc,chd->lhd", x, p["query"]["kernel"])
    k = np.einsum("lc,chd->lhd", x, p["key"]["kernel"])
    v = np.einsum("lc,chd->lhd", x, p["value"]["kernel"])
    L, H, D = q.shape
    if rope_n is not None:
        cos, sin = _rope_tables(D, rope_n)
        cos, sin = cos[:L, None, :], sin[:L, None, :]
        q = q * cos + _rotate_half(q) * sin
        k = k * cos + _rotate_half(k) * sin
    q = q / np.sqrt(F32(D))
    s = np.einsum("qhd,khd->hqk", q, k).astype(F32)
    if key_mask is not None:
        s = np.where(key_mask[None, None, :], BIG_NEG, s)
    s = s - s.max(-1, keepdims=True)
    w = np.exp(s)
    w = w / w.sum(-1, keepdims=True)
    o = np.einsum("hqk,khd->qhd", w.astype(F32), v)
    return np.einsum("qhd,hdc->qc", o, p["out"]["kernel"]).astype(F32)


def llama_layer(x, p, key_mask=None, rope_n=None, film=None):
    h = attention(rms_norm(x, p["ln_1"]), p["attn"], key_mask, rope_n)
    if film is not None:
        a_s, a_b, o_s, o_b = film
        h = h * a_s + a_b
    x = x + h
    y = glu(rms_norm(x, p["ln_2"]), p["mlp"])
    if film is not None:
        y = y * o_s + o_b
    return (x + y).astype(F32)


class NumpyModel:
    def __init__(self, tree: Dict):
        p = tree["params"] if "params" in tree else tree
        self.p = {k: _to_f32(v) for k, v in p.items()}
        self.E = self.p["Encoder_0"]["Embed_0"]["embedding"]
        self.embedding_rows = self.E.shape[0]

    # ------------------------------------------------------------------ #
    def action_encoder(self, x):
        p = self.p["Encoder_0"]["ActionEncoderV1_0"]
        return [p[f"Embed_{i}"]["embedding"][x[:, i]] for i in range(9)]

    def card_encoder(self, x_id, x):
        p = self.p["Encoder_0"]["CardEncoder_0"]
        e = lambda i, idx: p[f"Embed_{i}"]["embedding"][idx]
        x1 = x[:, :10].astype(np.int64)
        x2 = x[:, 10:].astype(F32)
        feats = [
            e(8, x1[:, 0]), e(9, x1[:, 1]),
            e(0, x1[:, 2]), e(1, x1[:, 3]), e(2, x1[:, 4]), e(3, x1[:, 5]),
            e(4, x1[:, 6]), e(5, x1[:, 7]), e(6, x1[:, 8]), e(7, x1[:, 9]),
            num_transform(x2[:, 0:2], p["MLP_0"]) @ p["Dense_0"]["kernel"],
            num_transform(x2[:, 2:4], p["MLP_0"]) @ p["Dense_1"]["kernel"],
            x2[:, 4:] @ p["Dense_2"]["kernel"],
        ]
        xid = silu(x_id @ p["MLP_1"]["Dense_0"]["kernel"])
        xc = (np.concatenate(feats, -1).astype(F32) @ p["MLP_2"]["Dense_0"]["kernel"]) * xid
        return layer_norm(xc, p["LayerNorm_0"])

    def global_encoder(self, g):
        p = self.p["Encoder_0"]["GlobalEncoder_0"]
        e = lambda i, idx: p[f"Embed_{i}"]["embedding"][idx]
        x1 = g[:4].astype(F32)
        x2 = g[4:8].astype(np.int64)
        x3 = g[8:22].astype(np.int64)
        lp = num_transform(x1[0:2], p["MLP_0"]) @ p["Dense_0"]["kernel"]
        olp = num_transform(x1[2:4], p["MLP_0"]) @ p["Dense_1"]["kernel"]
        x = np.concatenate([lp, olp, e(2, x2[0]), e(3, x2[1]), e(4, x2[2]), e(5, x2[3]),
                            e(0, x3).reshape(-1), e(1, x3[1]), e(1, x3[8])]).astype(F32)
        return layer_norm(x, p["LayerNorm_0"])

    def encoder(self, obs):
        P = self.p["Encoder_0"]
        E = self.E
        cards = np.asarray(obs["cards_"])
        g = np.asarray(obs["global_"])
        a = np.asarray(obs["actions_"]).astype(np.int64)
        h = np.asarray(obs["h_actions_"]).astype(np.int64)

        # cards
        f_cards = self.card_encoder(E[decode_id(cards[:, :2])], cards[:, 2:])
        f_cards = np.concatenate([P["g_card_embed"], f_cards], 0).astype(F32)
        for i in range(2):
            f_cards = llama_layer(f_cards, P[f"LlamaEncoderLayer_{i}"])
        f_cards = layer_norm(f_cards, P["LayerNorm_0"])
        f_g_card = f_cards[0]

        # global
        xg = self.global_encoder(g) @ P["Dense_0"]["kernel"]
        f_global = xg + glu(layer_norm(xg, P["LayerNorm_1"]), P["GLUMlp_0"])
        f_global = layer_norm(f_global, P["LayerNorm_2"])

        # history
        h_mask = h[:, 3] == 0
        h_mask[0] = False
        x_h_id = E[decode_id(h[:, 1:3])] @ P["Dense_1"]["kernel"]
        hf = self.action_encoder(h[:, 3:12]) + [
            x_h_id, P["Embed_1"]["embedding"][h[:, 12]], P["Embed_2"]["embedding"][h[:, 13]]]
        hf = layer_norm(np.concatenate(hf, -1).astype(F32), P["LayerNorm_3"]) @ P["Dense_2"]["kernel"]
        fh = llama_layer(hf.astype(F32), P["LlamaEncoderLayer_2"], key_mask=h_mask, rope_n=64)
        f_g_h = layer_norm(fh[0], P["LayerNorm_4"])

        # actions
        f_cards_n = np.concatenate([P["na_card_embed"], f_cards[1:]], 0)
        f_a_cards = f_cards_n[a[:, 0]]
        x_a_id = E[decode_id(a[:, 1:3])] @ P["Dense_3"]["kernel"]
        af = self.action_encoder(a[:, 3:]) + [x_a_id]
        af = layer_norm(np.concatenate(af, -1).astype(F32), P["LayerNorm_5"]) @ P["Dense_4"]["kernel"]
        f_a_cards = f_a_cards @ P["Dense_5"]["kernel"]
        f_actions = (af + (silu(f_a_cards) * af) @ P["Dense_6"]["kernel"]).astype(F32)
        a_mask = a[:, 3] == 0
        a_mask[0] = False
        f_ag = f_actions @ P["Dense_7"]["kernel"]
        keep = (~a_mask).astype(F32)
        f_g_actions = (f_ag * keep[:, None]).sum(0) / keep.sum()

        f_state = np.concatenate([f_g_card, f_global, f_g_h, f_g_actions]).astype(F32)
        f_state = layer_norm(glu(f_state, P["GLUMlp_1"]), P["LayerNorm_6"])
        return f_actions, f_state, a_mask

    def lstm(self, rstate, x):
        p = self.p["OptimizedLSTMCell_0"]
        c, h = (np.asarray(r, F32).reshape(-1) for r in rstate)
        gate = lambda n: x @ p["i" + n]["kernel"] + h @ p["h" + n]["kernel"] + p["h" + n]["bias"]
        i, f, g, o = sigmoid(gate("i")), sigmoid(gate("f")), np.tanh(gate("g")), sigmoid(gate("o"))
        c2 = (f * c + i * g).astype(F32)
        h2 = (o * np.tanh(c2)).astype(F32)
        return (c2, h2), h2

    def forward(self, rstate, obs) -> Tuple[Tuple[np.ndarray, np.ndarray], np.ndarray, float]:
        f_actions, f_state, a_mask = self.encoder(obs)
        rstate2, f = self.lstm(rstate, f_state)
        A = self.p["FiLMActor_0"]
        t = f @ A["Dense_0"]["kernel"] + A["Dense_0"]["bias"]
        film = np.split(t.astype(F32), 4)
        fa = llama_layer(f_actions, A["LlamaEncoderLayer_0"], key_mask=a_mask, film=film)
        logits = (fa @ A["Dense_1"]["kernel"] + A["Dense_1"]["bias"])[:, 0]
        logits = np.where(a_mask, BIG_NEG, logits)
        z = logits - logits.max()
        probs = np.exp(z)
        probs = probs / probs.sum()
        C = self.p["Critic_0"]
        v = f
        for i in range(3):
            v = leaky(v @ C["MLP_0"][f"Dense_{i}"]["kernel"])
        value = float((v @ C["Dense_0"]["kernel"] + C["Dense_0"]["bias"])[0])
        return rstate2, probs.astype(F32), value


def _to_f32(v):
    if isinstance(v, dict):
        return {k: _to_f32(x) for k, x in v.items()}
    return np.asarray(v, dtype=F32)
