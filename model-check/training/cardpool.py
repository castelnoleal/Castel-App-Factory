#!/usr/bin/env python3
"""Card pool management for Synapse training.

The pretrained ygo-agent model knows 864 cards; a model's card ids are the line
numbers of its code_list.txt. To teach it new decks we *append* the missing
cards (existing ids never move, so everything the model learned is kept) and
give the new rows a sensible starting embedding (see resize_ckpt.py).

    python cardpool.py build --base-code-list models/base/code_list.txt \
        --decks decks/ --cdb ygopro-database/locales/en-US/cards.cdb \
        --scripts ygopro-scripts --out models/synapse

Writes into --out:
    code_list.txt        base list + new cards (one passcode per line)
    aliases.json         alternate-artwork passcode -> base passcode
    decks/<name>.ydk     decks with alternate arts normalized to base passcodes
    cardpool.json        report: new cards, cards without scripts, per-deck stats
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import sys
from dataclasses import dataclass
from typing import Dict, List, Tuple

# ygopro/EDOPro treat a card whose alias is within this distance as an
# alternate artwork of the same card (DataManager CARD_ARTWORK_VERSIONS_OFFSET).
ARTWORK_OFFSET = 20

TYPE_MONSTER, TYPE_SPELL, TYPE_TRAP = 0x1, 0x2, 0x4
TYPE_FUSION, TYPE_SYNCHRO, TYPE_XYZ, TYPE_LINK = 0x40, 0x2000, 0x800000, 0x4000000
TYPE_TOKEN = 0x4000
EXTRA_TYPES = TYPE_FUSION | TYPE_SYNCHRO | TYPE_XYZ | TYPE_LINK


@dataclass
class CardRow:
    code: int
    alias: int
    type: int
    level: int
    attribute: int
    race: int
    atk: int
    defense: int
    name: str


def load_db(path: str) -> Dict[int, CardRow]:
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    rows = con.execute(
        "SELECT d.id, d.alias, d.type, d.level, d.attribute, d.race, d.atk, d.def, "
        "COALESCE(t.name, '') FROM datas d LEFT JOIN texts t ON d.id = t.id").fetchall()
    con.close()
    return {r[0]: CardRow(r[0], r[1], r[2], r[3] & 0xff, r[4], r[5], r[6], r[7], r[8]) for r in rows}


def base_code(code: int, db: Dict[int, CardRow]) -> int:
    row = db.get(code)
    if row and row.alias and abs(row.alias - code) < ARTWORK_OFFSET:
        return row.alias
    return code


def alias_map(db: Dict[int, CardRow]) -> Dict[int, int]:
    return {c: base_code(c, db) for c in db if base_code(c, db) != c}


def read_ydk(path: str) -> Tuple[List[int], List[int], List[int]]:
    main, extra, side = [], [], []
    cur = main
    with open(path, encoding="utf-8-sig", errors="replace") as f:
        for line in f:
            s = line.strip()
            if s.startswith("#main"):
                cur = main
            elif s.startswith("#extra"):
                cur = extra
            elif s.startswith("!side"):
                cur = side
            elif s.isdigit():
                cur.append(int(s))
    return main, extra, side


def write_ydk(path: str, main: List[int], extra: List[int], side: List[int], comment: str = ""):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(f"#created by Synapse {comment}\n#main\n")
        f.writelines(f"{c}\n" for c in main)
        f.write("#extra\n")
        f.writelines(f"{c}\n" for c in extra)
        f.write("!side\n")
        f.writelines(f"{c}\n" for c in side)


def read_code_list(path: str) -> List[int]:
    with open(path) as f:
        return [int(l.split()[0]) for l in f if l.strip()]


def list_decks(path: str) -> List[str]:
    if os.path.isfile(path):
        return [path]
    out = []
    for root, _, files in os.walk(path):
        out += [os.path.join(root, f) for f in sorted(files) if f.lower().endswith(".ydk")]
    return sorted(out)


def build(args) -> dict:
    db = load_db(args.cdb)
    base = read_code_list(args.base_code_list)
    known = set(base)
    os.makedirs(os.path.join(args.out, "decks"), exist_ok=True)

    new_codes: List[int] = []
    missing_db, missing_script = set(), set()
    deck_report = {}
    for deck_path in list_decks(args.decks):
        name = os.path.splitext(os.path.basename(deck_path))[0]
        main, extra, side = read_ydk(deck_path)
        norm = [[base_code(c, db) for c in part] for part in (main, extra, side)]
        unknown_before = 0
        for c in sorted(set(norm[0] + norm[1])):
            if c not in db:
                missing_db.add(c)
                continue
            if args.scripts and not os.path.exists(os.path.join(args.scripts, f"c{c}.lua")):
                if not (db[c].type & TYPE_MONSTER and not db[c].type & 0x20 and not db[c].type & EXTRA_TYPES):
                    missing_script.add(c)  # normal monsters legitimately have no script
            if c not in known:
                unknown_before += 1
                known.add(c)
                new_codes.append(c)
        # The env preloads side decks too; training is game-one only, so the side deck
        # is dropped unless its cards are added to the code list (--include-side).
        write_ydk(os.path.join(args.out, "decks", name + ".ydk"), norm[0], norm[1],
                  norm[2] if args.include_side else [], comment=f"from {os.path.basename(deck_path)}")
        deck_report[name] = {"main": len(main), "extra": len(extra), "unique": len(set(norm[0] + norm[1])),
                             "new_cards": unknown_before}

    # side decks are irrelevant to training but keep their cards known when asked
    if args.include_side:
        for deck_path in list_decks(args.decks):
            for c in read_ydk(deck_path)[2]:
                c = base_code(c, db)
                if c in db and c not in known:
                    known.add(c)
                    new_codes.append(c)

    codes = base + new_codes
    with open(os.path.join(args.out, "code_list.txt"), "w") as f:
        f.write("\n".join(str(c) for c in codes) + "\n")
    aliases = {str(k): v for k, v in alias_map(db).items() if v in known}
    with open(os.path.join(args.out, "aliases.json"), "w") as f:
        json.dump(aliases, f)

    num_embeddings = max(999, len(codes))
    report = {
        "base_cards": len(base),
        "new_cards": len(new_codes),
        "total_cards": len(codes),
        "num_embeddings": num_embeddings,
        "needs_resize": len(codes) > 999,
        "new_card_codes": new_codes,
        "new_card_names": {str(c): db[c].name for c in new_codes if c in db},
        "missing_in_database": sorted(missing_db),
        "missing_scripts": {str(c): db[c].name for c in sorted(missing_script)},
        "decks": deck_report,
    }
    with open(os.path.join(args.out, "cardpool.json"), "w") as f:
        json.dump(report, f, indent=2)
    for name in ("cards.cdb",):
        if args.copy_db:
            shutil.copyfile(args.cdb, os.path.join(args.out, name))
    return report


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="extend the code list for a set of decks")
    b.add_argument("--base-code-list", required=True)
    b.add_argument("--decks", required=True, help=".ydk file or folder")
    b.add_argument("--cdb", required=True, help="cards.cdb with the new cards")
    b.add_argument("--scripts", help="card script folder (to report cards without scripts)")
    b.add_argument("--out", required=True)
    b.add_argument("--include-side", action="store_true")
    b.add_argument("--copy-db", action="store_true")
    args = ap.parse_args(argv)
    if args.cmd == "build":
        r = build(args)
        print(f"cards: {r['base_cards']} known + {r['new_cards']} new = {r['total_cards']} "
              f"(embedding rows {r['num_embeddings'] + 1})")
        for name, d in r["decks"].items():
            print(f"  {name}: {d['main']} main / {d['extra']} extra, {d['new_cards']} new to the model")
        if r["missing_in_database"]:
            print(f"WARNING: {len(r['missing_in_database'])} cards missing in cards.cdb: "
                  f"{r['missing_in_database'][:10]}")
        if r["missing_scripts"]:
            print(f"WARNING: {len(r['missing_scripts'])} cards have no script and will act as vanilla "
                  f"in training: {list(r['missing_scripts'].values())[:10]}")
        return 0


if __name__ == "__main__":
    sys.exit(main())
