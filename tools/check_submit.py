#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""投稿漏斗自检: 不启服务、不碰语料, 只测"用户粘进来的东西会不会被静默丢掉"。

2026-09-24 实测抓到过的坑(每一条都对应下面一个用例, 别再犯):
  1. `63731232 1765`(手打了空格的数字串)被整串当非法 token **静默丢掉** -> 返回"只留了投稿，没有数字";
  2. `git commit -- <新文件>` 不含未跟踪文件 -> 投稿成功了却**没提交**(报"路径规格未匹配任何 Git 已知文件");
  3. `{"tags": ["民歌"]}`(list)打爆 `re.split` -> 500;
  4. 同一秒内同曲名投稿 -> 留档 id 撞车, 前一份被覆盖;
  5. 认不出的字符(汉字/英文)被丢掉却不告诉用户。

用法:
    python3 tools/check_submit.py              # 只跑纯逻辑(默认, 安全)
    python3 tools/check_submit.py --live URL   # 再打一遍真接口(请指向隔离实例!)
"""
import argparse
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)
ROOT = os.path.dirname(WEB)
SERVER = os.path.join(WEB, "app", "server.py")
DB = os.environ.get("JIANPU_DB") or os.path.join(ROOT, "jianpu-db")

fails = []


def ok(cond, msg):
    print(("✓ " if cond else "✗ ") + msg)
    if not cond:
        fails.append(msg)


def load_server(db):
    """把 server.py 当模块加载(它 import 后不会写任何东西, 只建目录常量的字符串)。"""
    old = os.environ.get("JIANPU_DB")
    os.environ["JIANPU_DB"] = db
    sys.argv = ["server.py", "0"]          # 不让它去 bind 端口
    spec = importlib.util.spec_from_file_location("jianpu_server_under_test", SERVER)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    if old is None:
        os.environ.pop("JIANPU_DB", None)
    else:
        os.environ["JIANPU_DB"] = old
    return mod


def test_fields(m):
    """客户端可能把字段送成 list/数字 -> 必须统一成字符串, 不许 500(坑 3)。"""
    ok(m._as_text(["民歌", "儿歌"]) == "民歌,儿歌", "_as_text(list) 拼成逗号串")
    ok(m._as_text(None) == "", "_as_text(None) 是空串")
    ok(m._as_text(5) == "5", "_as_text(int) 转字符串")
    ok(m._as_text("x") == "x", "_as_text(str) 原样")
    ok(not any(c in m._safe('a/b\\c:d*e?f"g<h>i|j', 60) for c in '/\\:*?"<>|'),
       "_safe 去掉了路径字符(曲名当文件名用)")


def test_normalize(m):
    """归一化: 用户怎么写都得收下(坑 1), 丢了东西必须说(坑 5)。"""
    cases = [
        ("63731232", ["6", "3", "7", "3", "1", "2", "3", "2"], False),
        ("6 3 7 3 1 2 3 2", ["6", "3", "7", "3", "1", "2", "3", "2"], False),
        ("63731232 1765", ["6", "3", "7", "3", "1", "2", "3", "2", "1", "7", "6", "5"], False),
        ("6q3s7q1c2d3h4", ["6q", "3s", "7q", "1c", "2d", "3h", "4"], False),
        ("1 2 | 3 4", ["1", "2", "|", "3", "4"], False),
        ("6-7 1 2", ["6", "-", "7", "1", "2"], False),
        ("#4 5 6 7 1", ["#4", "5", "6", "7", "1"], False),
        ("1' 2' 3 4 5", ["1'", "2'", "3", "4", "5"], False),
        ("6b7 1 2 3", ["6", "b7", "1", "2", "3"], False),
        ("", [], False),
        ("5", ["5"], True),                                  # 太少, 要警告
        ("abc 你好 12345", ["1", "2", "3", "4", "5"], True),  # 垃圾字符, 要警告
        ("8 9 1 2 3 4", ["1", "2", "3", "4"], True),          # 8/9 不是简谱数字, 要警告
    ]
    for src, want_toks, want_warn in cases:
        toks, warn = m.normalize_melody(src)
        ok(toks == want_toks, f"归一化 {src!r} -> {toks}")
        ok(bool(warn) == want_warn, f"归一化 {src!r} 警告{'有' if want_warn else '无'}"
                                   + (f"(实际: {warn[:40]})" if bool(warn) != want_warn else ""))
    # 手打了空格的那串(坑 1)必须真的进得了谱, 不能"只留投稿"
    toks, _ = m.normalize_melody("63731232 1765")
    ok(len(toks) >= 5, "手打空格的数字串不再是 0 个音符")


def test_unique_rid(m, tmp):
    """同一秒同曲名反复投 -> id 必须各不相同(坑 4)。"""
    m.FEEDBACK = tmp
    base = "20260924-120000-同曲名"
    rids = []
    for _ in range(4):                  # 每次"取 id 就立刻留档", 与真实调用顺序一致
        r = m._unique_rid(base)
        with open(os.path.join(tmp, r + ".json"), "w") as g:
            g.write("{}")
        rids.append(r)
    ok(len(set(rids)) == 4, f"同秒同曲名 4 次投稿拿到 4 个不同 id: {rids}")
    ok(len(os.listdir(tmp)) == 4, "4 份留档都在, 没有互相覆盖")


def test_git_commit(m, tmp):
    """只提交本次投稿的文件, 且**必须包含未跟踪的新文件**(坑 2)。"""
    def run(*a, **kw):
        return subprocess.run(["git"] + list(a), cwd=tmp, capture_output=True, text=True, **kw)
    run("init", "-q")
    run("config", "user.name", "t")
    run("config", "user.email", "t@local")
    with open(os.path.join(tmp, "tracked.txt"), "w") as g:
        g.write("base\n")
    run("add", "tracked.txt")
    run("commit", "-q", "-m", "base")
    # 本次投稿产生的新文件 + 一个"跟这次无关的脏文件"
    with open(os.path.join(tmp, "new.txt"), "w") as g:
        g.write("投稿\n")
    with open(os.path.join(tmp, "tracked.txt"), "w") as g:
        g.write("别人改的\n")
    old_db, old_safe = m.DB, m._safe
    m.DB = tmp
    try:
        rc, out = m._git_commit("test: 投稿", ["new.txt"])
    finally:
        m.DB = old_db
    ok(rc == 0, f"新文件也能提交上(rc={rc} {out.strip()[:80]})")
    committed = run("show", "--name-only", "--pretty=format:", "HEAD").stdout.split()
    ok("new.txt" in committed, f"新文件进了这次提交: {committed}")
    ok("tracked.txt" not in committed, f"无关的脏文件没进这次提交: {committed}")
    ok(run("show", "HEAD:tracked.txt").stdout == "base\n", "HEAD 里的 tracked.txt 还是原样")
    ok(run("status", "--porcelain").stdout.strip().endswith("tracked.txt"),
       "无关的脏文件仍然留在工作区(git 状态看得见): " + run("status", "--porcelain").stdout.strip())


def test_live(url):
    """可选: 打真接口(请指向隔离实例, 会真的写语料/留档/提交)。"""
    import urllib.error
    import urllib.request
    def post(payload):
        req = urllib.request.Request(url.rstrip("/") + "/api/submit",
                                     data=json.dumps(payload).encode(),
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:      # 4xx 也是**正常的业务回答**(带 JSON 说明)
            return json.loads(e.read().decode())
    j = post({"kind": "new", "title": "自检投稿曲", "score": "63731232", "note": "check_submit"})
    ok(j.get("ok") and j.get("score_file"), f"new: 生成了曲谱 {j.get('score_file')}")
    ok(j.get("committed") is True, "new: 已 git commit")
    ok(not j.get("score_warn"), "new: 没有多余警告")
    j = post({"kind": "new", "title": "自检投稿乙", "score": "abc 12345"})
    ok(j.get("score_warn"), "认不出的字符有警告: " + (j.get("score_warn") or "")[:50])
    j = post({"kind": "fix", "title": "自检投稿曲", "file": "自检投稿曲.txt", "score": "1 2 3 4 5"})
    ok(j.get("ok") and j.get("score_file"), "fix: 带目标也入库")
    j = post({"kind": "tags", "title": "自检", "file": "自检投稿曲.txt", "tags": ["民歌"]})
    ok(j.get("ok"), "tags 收 list 不 500")
    j = post({"kind": "link", "title": "自检", "file": "自检投稿曲.txt",
              "url": "https://www.qupu123.com/search?q=x"})
    ok(j.get("ok") is False, "搜索页 URL 被拒: " + (j.get("err") or "")[:40])
    j = post({"kind": "meta", "title": "", "note": "空曲名"})
    ok(j.get("ok") is False, "空曲名被拒")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", help="再打一遍真接口(指向隔离实例)")
    ap.add_argument("--db", default=DB, help=f"按哪个 DB 加载 server.py(默认 {DB})")
    a = ap.parse_args()
    m = load_server(a.db)
    tmp = tempfile.mkdtemp(prefix="jpsubmit-")
    fb = os.path.join(tmp, "feedback")
    repo = os.path.join(tmp, "repo")
    os.makedirs(fb)
    os.makedirs(repo)
    print(f"用 DB={a.db}\n")
    try:
        test_fields(m)
        test_normalize(m)
        test_unique_rid(m, fb)
        test_git_commit(m, repo)
        if a.live:
            print()
            test_live(a.live)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("\n投稿漏斗自检 " + (f"失败 {len(fails)} 项" if fails else "通过"))
    for f in fails:
        print("  ✗ " + f)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
