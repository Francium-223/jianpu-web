#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""列出"索引真正引用到的原图" —— 传给 R2 的清单（别把 9.5GB 全传，只传用得上的）。

为什么只传一部分: 工作区里 `images/` + `images-prep/` 一共 9.47GB / 38k 张, 但
`data/images.jsonl.gz`（原图索引）只引用 **26,416 张 / 5.08GB** —— 其余是抓了没转写、
或者被切图/派生件顶掉的。R2 免费额度 10GB, 传用得上的那 5GB 就够了。

输出（默认 `_analysis/r2_files.txt`, 每行一个**相对工作区根**的路径）:
    images-prep/qupu123-crawl/曲名__qupu123-1/001.jpg
这个路径就是 R2 的 **key**（与 `/img/<key>` 一一对应, Worker 直接查表）。

给 rclone 用（推荐, 能按清单同步、还能并发）:
    rclone copy /home/<你>/jianpu <远端>:jianpu-images --files-from _analysis/r2_files.txt --transfers 16
给 aws-cli 用:
    xargs -a _analysis/r2_files.txt -P 8 -I{} aws s3 cp /home/<你>/jianpu/{} s3://jianpu-images/{} --endpoint-url ...

⚠ key 的编码: rclone / aws-cli 会把**原样 UTF-8**（中文目录名）当 key —— 这是**规范形式**,
Worker 优先按它查。`wrangler r2 object put` 会把 key 百分号编码后再存（实测），Worker 也兼容
（找不到就按 URL 原样路径再查一次）, 但别用它传大批量（一个文件一个进程, 26k 次）。
"""
import argparse
import gzip
import io
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)
WS = os.path.dirname(WEB)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--index", default=os.path.join(WEB, "data", "images.jsonl.gz"))
    ap.add_argument("--out", default=os.path.join(WS, "_analysis", "r2_files.txt"))
    ap.add_argument("--include-alt", action="store_true", default=True,
                    help="连「备选扫描件」一起列(默认开: 谱页上会显示它们)")
    ap.add_argument("--no-alt", dest="include_alt", action="store_false")
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    if not os.path.isfile(a.index):
        sys.exit("没有原图索引 %s（先跑 tools/build_web_data.py）" % a.index)

    seen, rows, missing = set(), [], []
    n_bytes = 0
    with gzip.open(a.index, "rt", encoding="utf-8") as f:
        for ln in f:
            if not ln.strip():
                continue
            r = json.loads(ln)
            files = [(r["d"], p[0]) for p in r["pg"]]
            if a.include_alt:
                for alt in (r.get("alt") or []):
                    files += [(alt[0], x) for x in alt[1]]
            for d, fn in files:
                rel = "%s/%s" % (d, fn)
                if rel in seen:
                    continue
                seen.add(rel)
                p = os.path.join(WS, rel)
                if os.path.isfile(p):
                    rows.append(rel)
                    n_bytes += os.path.getsize(p)
                else:
                    missing.append(rel)
    with io.open(a.out, "w", encoding="utf-8", newline="\n") as g:
        g.write("\n".join(rows) + "\n")
    print("清单: %s" % a.out)
    print("  %d 个文件, %.2f GB" % (len(rows), n_bytes / 1e9))
    if missing:
        print("  ! 索引里有 %d 个文件盘上找不到（先看看是不是图片换了目录）: %s"
              % (len(missing), missing[:3]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
