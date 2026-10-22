#!/usr/bin/env python3
"""Prepare a checkpoint for an extended card pool.

Card ids are rows of the card-embedding table (params/Encoder_0/Embed_0/embedding,
shape (1 + num_embeddings, 1024)). New cards get rows after the old ones, so
everything already learned stays in place. A new row starts as the average of
the most similar known cards (same frame/attribute/type, then broader), which
gives training a far better starting point than random noise.

    python resize_ckpt.py --checkpoint models/base/0546_22750M.flax_model \
        --base-code-list models/base/code_list.txt \
        --code-list models/synapse/code_list.txt --cdb .../cards.cdb \
        --out models/synapse/start.flax_model

Prints the --num-embeddings value training and the server must use.
Only needs numpy + msgpack (flax's on-disk format is plain msgpack).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict
from typing import Dict, List, Optional

import numpy as np

try:
    import msgpack
except ImportError:  # pragma: no cover
    sys.exit("pip install msgpack")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cardpool import CardRow, load_db, read_code_list  # noqa: E402

EMBED_PATH = ("params", "Encoder_0", "Embed_0", "embedding")

# flax.serialization ext types
_EXT_NDARRAY, _EXT_COMPLEX, _EXT_NPSCALAR = 1, 2, 3


def _ext_hook(code, data):
    if code in (_EXT_NDARRAY, _EXT_NPSCALAR):
        shape, dtype, buf = msgpack.unpackb(data, raw=True)
        arr = np.frombuffer(buf, dtype=np.dtype(dtype.decode() if isinstance(dtype, bytes) else dtype))
        arr = arr.reshape(shape)
        return arr if code == _EXT_NDARRAY else arr[()]
    return msgpack.ExtType(code, data)


def _ext_default(x):
    if isinstance(x, np.ndarray):
        return msgpack.ExtType(_EXT_NDARRAY, msgpack.packb(
            (x.shape, x.dtype.name, x.tobytes("C")), use_bin_type=True))
    if isinstance(x, np.generic):
        a = np.asarray(x)
        return msgpack.ExtType(_EXT_NPSCALAR, msgpack.packb(
            (a.shape, a.dtype.name, a.tobytes("C")), use_bin_type=True))
    raise TypeError(f"cannot serialize {type(x)}")


def load_checkpoint(path: str) -> dict:
    with open(path, "rb") as f:
        return msgpack.unpackb(f.read(), ext_hook=_ext_hook, raw=False, strict_map_key=False)


def dump_checkpoint(tree: dict) -> bytes:
    return msgpack.packb(tree, default=_ext_default, strict_types=True)


def get_embedding(tree: dict) -> np.ndarray:
    node = tree
    for k in EMBED_PATH:
        node = node[k]
    return node


def set_embedding(tree: dict, value: np.ndarray):
    node = tree
    for k in EMBED_PATH[:-1]:
        node = node[k]
    node[EMBED_PATH[-1]] = value


# --------------------------------------------------------------------------- #

def _frame(t: int) -> str:
    if t & 0x2:
        for bit, name in ((0x10000, "quick"), (0x20000, "cont"), (0x40000, "equip"),
                          (0x80000, "field"), (0x80, "ritual")):
            if t & bit:
                return "spell_" + name
        return "spell_normal"
    if t & 0x4:
        for bit, name in ((0x100000, "counter"), (0x20000, "cont")):
            if t & bit:
                return "trap_" + name
        return "trap_normal"
    for bit, name in ((0x4000000, "link"), (0x800000, "xyz"), (0x2000, "synchro"),
                      (0x40, "fusion"), (0x80, "ritual"), (0x1000000, "pendulum")):
        if t & bit:
            return "mon_" + name + ("_tuner" if t & 0x1000 else "")
    return "mon_" + ("effect" if t & 0x20 else "normal") + ("_tuner" if t & 0x1000 else "")


def similarity_keys(row: Optional[CardRow]) -> List[tuple]:
    """Most specific first."""
    if row is None:
        return []
    f = _frame(row.type)
    if f.startswith("mon_"):
        return [(f, row.attribute, row.race, min(row.level, 12)), (f, row.attribute, row.race),
                (f, row.attribute), (f,), ("mon",)]
    return [(f,), (f.split("_")[0],)]


def init_new_rows(emb: np.ndarray, base_codes: List[int], new_codes: List[int],
                  db: Dict[int, CardRow], noise: float, seed: int) -> Dict[str, int]:
    rng = np.random.default_rng(seed)
    known_rows = emb[1:1 + len(base_codes)]
    std = float(known_rows.std())
    groups: Dict[tuple, List[int]] = defaultdict(list)
    for i, code in enumerate(base_codes, start=1):
        for key in similarity_keys(db.get(code)):
            groups[key].append(i)
    mean_all = known_rows.mean(axis=0)
    stats = defaultdict(int)
    for j, code in enumerate(new_codes):
        row_id = 1 + len(base_codes) + j
        vec, used = None, "global"
        for depth, key in enumerate(similarity_keys(db.get(code))):
            members = groups.get(key)
            if members:
                vec = emb[members].mean(axis=0)
                used = f"level{depth}"
                break
        if vec is None:
            vec = mean_all
        emb[row_id] = vec + rng.normal(0.0, noise * std, size=vec.shape).astype(emb.dtype)
        stats[used] += 1
    return dict(stats)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--base-code-list", required=True, help="code list the checkpoint was trained with")
    ap.add_argument("--code-list", required=True, help="extended code list (cardpool.py)")
    ap.add_argument("--cdb", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--noise", type=float, default=0.05, help="noise, as a fraction of the embedding std")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args(argv)

    base = read_code_list(args.base_code_list)
    codes = read_code_list(args.code_list)
    if codes[:len(base)] != base:
        sys.exit("the extended code list must start with the base code list (ids must not move)")
    new_codes = codes[len(base):]
    tree = load_checkpoint(args.checkpoint)
    emb = np.array(get_embedding(tree), dtype=np.float32, copy=True)
    old_rows = emb.shape[0]
    if len(base) + 1 > old_rows:
        sys.exit(f"base code list has {len(base)} cards but the checkpoint only {old_rows - 1} rows")

    num_embeddings = max(old_rows - 1, len(codes))
    if num_embeddings + 1 > old_rows:
        grown = np.zeros((num_embeddings + 1, emb.shape[1]), dtype=emb.dtype)
        grown[:old_rows] = emb
        emb = grown
    db = load_db(args.cdb)
    stats = init_new_rows(emb, base, new_codes, db, args.noise, args.seed)
    set_embedding(tree, emb)
    data = dump_checkpoint(tree)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "wb") as f:
        f.write(data)
    info = {"num_embeddings": num_embeddings, "rows": int(emb.shape[0]), "old_rows": int(old_rows),
            "new_cards": len(new_codes), "init": stats, "checkpoint": os.path.abspath(args.out)}
    with open(os.path.splitext(args.out)[0] + ".json", "w") as f:
        json.dump(info, f, indent=2)
    print(json.dumps(info))
    return 0


if __name__ == "__main__":
    sys.exit(main())
