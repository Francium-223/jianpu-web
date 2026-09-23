# -*- coding: utf-8 -*-
"""把 jianpu-db 的 data.jsonl 转成前端索引(含**原谱原文**, 供结果页显示并高亮命中段)。

与前端的约定(与 static/jptok.js **同一套口径**):
  p : 音高串, 仅数字 1-7(不含升降号), 长度 = 音符数
  a : 变音串, 与 p 逐音对齐, 每字符 '0'(自然) / '1'(升) / '2'(降)
  o : 八度串, 与 p 逐音对齐, 每字符是 -2..2 的数字(可能带负号)
  s : 原谱原文(空格分隔的 token 流), 用于结果页显示与高亮
用法: py -3.13 tools/build_web_data.py [--data 路径] [--out 目录]
"""
import argparse
import gzip
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "..", "jianpu2", "skills", "jianpu-melody-lookup"))
sys.stdout.reconfigure(encoding="utf-8")
try:
    import jptok                      # 唯一 token 实现, 优先复用
except Exception:
    jptok = None
ZW = dict.fromkeys(map(ord, "\u200b-\u200f\u202a-\u202e\u2060\ufeff"), None)
TOK = re.compile(r"^([qsdh]*)([,']*)([#b♯♭]?)([1-7x0])([,']*)[.]*$")


def parse(t):
    if jptok:
        return jptok.parse_token(t)
    m = TOK.match(t)
    if not m:
        return None
    _pre, octs, acc, dig, post = m.groups()
    a = 1 if acc in ("#", "♯") else (-1 if acc in ("b", "♭") else 0)
    off = (octs + post).count(",") - (octs + post).count("'")
    return (None, a, off) if dig in "0x" else (int(dig), a, off)


def group_of(t):
    base = (t or "").translate(ZW).split("__")[0]
    return re.split(r"[（(\s　【\[《]", base)[0].strip() or base.strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=r"D:\Documents_D\jianpu-db\data.jsonl")
    ap.add_argument("--out", default=os.path.join(ROOT, "data"))
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    rows, srcs, notes = [], {}, 0
    for ln in io.open(a.data, encoding="utf-8"):
        ln = ln.strip()
        if not ln:
            continue
        r = json.loads(ln)
        score = r.get("score") or ""
        toks = [t for t in score.split() if parse(t)]
        p, acc, oct_ = [], [], []
        for t in toks:
            d, ac, off = parse(t)
            if d is None:                     # 休止/念白: 不进音高, 但仍在 s 里显示
                continue
            p.append(str(d))
            acc.append("1" if ac == 1 else "2" if ac == -1 else "0")
            oct_.append(str(off))
        if not p:
            continue
        src = r.get("source") or ""
        src = src[0] if isinstance(src, list) else src
        host = src.split("-")[0] if src else ""
        srcs[host] = srcs.get(host, 0) + 1
        notes += len(p)
        rows.append({
            "t": r.get("title") or "", "s": src, "st": r.get("status") or "",
            "n": len(p), "p": "".join(p), "a": "".join(acc), "o": ",".join(oct_),
            "g": group_of(r.get("title")),
            "mbid": (r.get("MBID") or ""),
            "raw": " ".join(toks if len(toks) < 400 else toks[:400]),
            "trunc": len(toks) > 400,
            # 小节线: data.jsonl 给的是"第 i 个音符之前有一条小节线"(0-based 音符下标)。
            # **按音符序号而非 token 序号**, 前端在音符流里对应位置插 `|`。
            "bars": [int(x) for x in (r.get("bars") or []) if isinstance(x, int)],
            "bpb": float(r.get("beats_per_bar") or 4.0),
            # 其余元数据一并带出(用户要求: 前端不光标题, 别的元数据也都摊开)
            "file": r.get("file") or [],
            "tags": r.get("tag") or [],
            "usertags": r.get("usertag") or [],
            "alias": r.get("alias") or [],
            "transcriber": r.get("transcriber") or [],
        })

    outj = os.path.join(a.out, "songs.jsonl.gz")
    with gzip.open(outj, "wb", compresslevel=9) as g:
        for r in rows:
            g.write((json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"))
    with gzip.open(os.path.join(a.out, "songs.jsonl"), "wb", compresslevel=0) as g:
        for r in rows:                        # 老浏览器回退(不压缩)
            g.write((json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"))
    stats = {"songs": len(rows), "notes": notes, "groups": len({r["g"] for r in rows}),
             "sources": dict(sorted(srcs.items(), key=lambda x: -x[1])),
             "bytes_gz": os.path.getsize(outj),
             "with_accidental": sum(1 for r in rows if "1" in r["a"] or "2" in r["a"]),
             "with_raw": sum(1 for r in rows if r["raw"])}
    with io.open(os.path.join(a.out, "stats.json"), "w", encoding="utf-8", newline="\n") as g:
        g.write(json.dumps(stats, ensure_ascii=False, indent=2))
    print(f"写出 {len(rows)} 首 -> {outj}  ({stats['bytes_gz']/1e6:.2f} MB gz)")
    print(f"  音符 {notes:,} · 含变音记号的 {stats['with_accidental']} 首 · 带原谱 {stats['with_raw']} 首")
    print(f"  来源 {stats['sources']}")


if __name__ == "__main__":
    main()
