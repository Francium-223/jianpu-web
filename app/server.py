# -*- coding: utf-8 -*-
"""静态服务 + **零登录投稿**后端。

为什么: 让用户去 GitHub 开 issue 是四重漏斗(链接能打开 -> 有账号 -> 愿意登录 -> 会写 issue),
每层都指数级掉人。这里改成: 前端一个按钮 -> POST 到本服务 -> 服务端**直接用本地 git 提交**
到 jianpu-db(反馈即入库), 同时把原始投稿留档。用户只需点一下, 不碰 GitHub。

接口:
  POST /api/submit   表单(JSON): {kind, title, score, note, contact}
      kind: "new"(推荐收录) / "fix"(纠错) / "meta"(元数据: 曲名/出处/标签不对)
      成功 -> 写入 jianpu-db/scores/ 或 feedback/ 并 git commit, 返回 {ok, id}
  GET  /api/health   -> {ok, repo, feedback_count}

安全: 默认只允许本机(127.0.0.1)与局域网; 有写盘 + git, 必须放在内网或加反代鉴权。
      另可设 JPSUBMIT_TOKEN 环境变量, 设了则要求请求头 X-Token 一致。
"""
import gzip
import html
import io
import json
import os
import re
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8770
DB = os.environ.get("JIANPU_DB", r"D:\Documents_D\jianpu-db")
FEEDBACK = os.path.join(DB, "feedback")
TOKEN = os.environ.get("JPSUBMIT_TOKEN", "")
sys.stdout.reconfigure(encoding="utf-8")

MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
        ".jsonl": "application/x-ndjson; charset=utf-8", ".gz": "application/gzip",
        ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon"}

NOTE = re.compile(r"^[,']*[qsdh]*[,']*[#b♯♭]?[1-7x0][,']*[.]*$")


def _safe(s, n=80):
    s = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", str(s or "")).strip()
    return (s[:n] or "untitled")


def _git(*args):
    """在 jianpu-db 里跑 git; 返回 (rc, out)。"""
    try:
        r = subprocess.run(["git"] + list(args), cwd=DB, capture_output=True, text=True, timeout=60)
        return r.returncode, ((r.stdout or "") + (r.stderr or "")).strip()[:400]
    except Exception as e:
        return 1, f"{type(e).__name__}: {e}"


def handle_submit(payload):
    """把投稿落盘并提交。返回 (http_status, dict)。"""
    kind = (payload.get("kind") or "new").strip()
    title = (payload.get("title") or "").strip()
    score = (payload.get("score") or "").strip()
    note = (payload.get("note") or "").strip()
    contact = (payload.get("contact") or "").strip()
    if not title:
        return 400, {"ok": False, "err": "请填曲名"}
    ts = time.strftime("%Y%m%d-%H%M%S")
    rid = f"{ts}-{_safe(title, 24)}"

    # ① 投稿原文留档(永远先存, 不怕后面失败)
    os.makedirs(FEEDBACK, exist_ok=True)
    rec = {"id": rid, "kind": kind, "title": title, "score": score, "note": note,
           "contact": contact, "time": time.strftime("%Y-%m-%d %H:%M:%S"),
           "ip": payload.get("_ip", "")}
    with io.open(os.path.join(FEEDBACK, rid + ".json"), "w", encoding="utf-8", newline="\n") as g:
        g.write(json.dumps(rec, ensure_ascii=False, indent=2))

    # ② 如果给了简谱数字 -> 直接生成一份曲谱进 scores/(反馈即入库)
    #    **先归一化**: 用户习惯是一整串数字(`63731232`), 而 token 白名单是逐 token 匹配的
    #    -> 粘在一起会被当"一个非法 token"整串丢掉(实测踩过: score_file 返回空)。
    #    这里在**数字与记号之间**补空格: `63731232` -> `6 3 7 3 1 2 3 2`, 已有空格的保持原样。
    wrote_score = ""
    src = score if " " in score.strip() else re.sub(r"\s*", " ", re.sub(r"([#b♯♭]?\d)", r" \1", score)).strip()
    if " " not in score.strip() and score.strip():
        src = " ".join(re.findall(r"[#b♯♭]?[0-9]", score))
    toks = [t for t in src.split() if NOTE.match(t) or t in ("-", "|", "~")]
    if len(toks) >= 5:
        name = _safe(title, 60)
        p = os.path.join(DB, "scores", name + ".txt")
        if os.path.exists(p):
            p = os.path.join(DB, "scores", f"{name}_{ts[-6:]}.txt")
        body = "\n".join([
            f"%{os.path.basename(p)}",
            f"title={title}",
            "tag=", "usertag=", "tagroute=",
            "transcriber=读者投稿", "status=ocr",
            f"% 投稿 {rid}" + (f" 联系 {contact}" if contact else ""),
            f"% 备注 {note}" if note else "% 备注 (无)",
            "source=user-submit",
            "%--", "4/4", "subtitle=score",
            " ".join(toks), "%END",
        ]) + "\n"
        with io.open(p, "w", encoding="utf-8", newline="\n") as g:
            g.write(body)
        wrote_score = os.path.basename(p)

    # ③ 本地 git 提交(不 push; push 由你/定时任务决定)
    _git("add", "-A", "feedback", "scores")
    msg = f"submission: {kind} - {title}"
    if wrote_score:
        msg += f" (+scores/{wrote_score})"
    rc, out = _git("-c", "user.name=reader-submit", "-c", "user.email=submit@local",
                   "commit", "-q", "-m", msg)
    committed = (rc == 0)
    return 200, {"ok": True, "id": rid, "score_file": wrote_score,
                 "committed": committed, "git": out[-200:] if not committed else ""}


def resolve(path):
    if path in ("/", ""):
        return os.path.join(ROOT, "static", "index.html")
    rel = path.lstrip("/")
    if not rel.startswith(("static/", "data/")):
        rel = os.path.join("static", rel)
    full = os.path.normpath(os.path.join(ROOT, rel))
    return full if full.startswith(ROOT) else None


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "jianpu-web"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s  %s\n" % (self.address_string(), fmt % args))

    def _json(self, code, obj):
        b = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(b)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type,X-Token")
        self.send_header("Access-Control-Allow-Methods", "POST,GET,OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path != "/api/submit":
            return self._json(404, {"ok": False, "err": "no such endpoint"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n <= 0 or n > 200_000:
            return self._json(400, {"ok": False, "err": "body 太大或为空"})
        raw = self.rfile.read(n)
        if TOKEN and self.headers.get("X-Token") != TOKEN:
            return self._json(403, {"ok": False, "err": "需要 X-Token"})
        try:
            payload = json.loads(raw.decode("utf-8"))
        except Exception:
            return self._json(400, {"ok": False, "err": "不是合法 JSON"})
        payload["_ip"] = self.client_address[0]
        try:
            code, out = handle_submit(payload)
        except Exception as e:
            return self._json(500, {"ok": False, "err": f"{type(e).__name__}: {e}"})
        return self._json(code, out)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/health":
            n = len(os.listdir(FEEDBACK)) if os.path.isdir(FEEDBACK) else 0
            return self._json(200, {"ok": True, "repo": DB, "feedback_count": n,
                                    "token_required": bool(TOKEN)})
        full = resolve(path)
        if not full or not os.path.isfile(full):
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        ext = os.path.splitext(full)[1].lower()
        with open(full, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    print(f"简谱旋律查歌 + 零登录投稿 -> http://127.0.0.1:{PORT}/")
    print(f"投稿落库: {DB}  (feedback/ 留档; 给了数字就直接进 scores/)")
    print(f"token 保护: {'开' if TOKEN else '关(仅本机/内网使用)'}")
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
