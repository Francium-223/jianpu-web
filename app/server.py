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

# 简谱 token 口径**只有一份**: 复用 skill 目录里的 jptok.py。
# 这里以前自带一份"前缀时值"正则 —— 投稿里若写 `6c.`/`5s`/`3q` 这种**后缀**时值,
# 那些 token 会被判成"不是音符"而整段丢掉(与 2026-09-23 索引丢音事故同一个坑)。
sys.path.insert(0, os.path.join(ROOT, "..", "jianpu2", "skills", "jianpu-melody-lookup"))
try:
    import jptok
except Exception:                       # 兜底正则: 与 jptok.py 同口径(时值+变音前后都认)
    jptok = None
NOTE = re.compile(r"^[cqsdh]*[,']*[#b♯♭]?[1-7x0][,']*[#b♯♭]?[cqsdh]*[.]*[\[\]]?$")
_is_note = (lambda t: jptok.is_note(t)) if jptok else (lambda t: bool(NOTE.match(t)))

# 收录页 URL 的口径**只有一份**: jianpu-db/linkurl.py(纯函数, 不读 tags.json)。
# 它同时负责"搜索页一律拒收"与"写进曲谱文件"—— 前端粘贴保存和 CLI 都走它。
sys.path.insert(0, DB)
try:
    import linkurl
except Exception:                       # DB 路径不对 -> 宁可拒绝写, 也不写未校验的 URL
    linkurl = None
HERE_WEB = ROOT
REFRESH_LOG = os.path.join(HERE_WEB, "data", "refresh.log")
REFRESH_LOCK = os.path.join(HERE_WEB, "data", ".refresh.lock")
REFRESH_PENDING = os.path.join(HERE_WEB, "data", ".refresh.pending")


def start_refresh():
    """后台重建索引: parse_scores(重建 data.jsonl/bars) + build_web_data(前端索引)。
    返回 (是否已排上, 说明)。若正有一轮在跑: 放一个 pending 标记让它在跑完后**再来一轮**,
    免得这一次保存的链接被漏掉(并发缺口)。"""
    script = os.path.join(HERE_WEB, "tools", "refresh.sh")
    if not os.path.isfile(script):
        return False, "没有 tools/refresh.sh"
    if os.path.exists(REFRESH_LOCK):
        try:
            if time.time() - os.path.getmtime(REFRESH_LOCK) < 600:
                with io.open(REFRESH_PENDING, "w", encoding="utf-8") as g:
                    g.write(str(os.getpid()))
                return True, "已排队(等当前重建跑完自动再来一轮)"
        except OSError:
            pass
    try:
        with io.open(REFRESH_LOCK, "w", encoding="utf-8") as g:
            g.write(str(os.getpid()))
        with io.open(REFRESH_LOG, "ab") as g:
            subprocess.Popen(["bash", script], cwd=HERE_WEB, stdout=g, stderr=subprocess.STDOUT,
                             start_new_session=True)
        return True, "已开始重建(约 2 分钟)"
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"


def save_link(payload, note="", contact=""):
    """人工补收录页: 校验(搜索页拒收) -> 留档 -> 写进 scores/<file>.txt -> git commit -> 后台重建。"""
    if linkurl is None:
        return 500, {"ok": False, "err": f"找不到 linkurl.py —— JIANPU_DB={DB} 对吗?"}
    base = os.path.basename(payload.get("file") or "")
    if not base or base != (payload.get("file") or "") or not base.endswith(".txt"):
        return 400, {"ok": False, "err": "文件名不合法"}
    path = os.path.join(DB, "scores", base)
    if not os.path.isfile(path):
        return 400, {"ok": False, "err": "语料里没有这份曲谱: " + base}
    # 留档(与其他投稿一致: 永远先存, 不怕后面失败)
    os.makedirs(FEEDBACK, exist_ok=True)
    rid = time.strftime("%Y%m%d-%H%M%S") + "-link-" + _safe(base[:-4], 20)
    with io.open(os.path.join(FEEDBACK, rid + ".json"), "w", encoding="utf-8", newline="\n") as g:
        g.write(json.dumps({"id": rid, "kind": "link", "file": base,
                            "url": payload.get("url") or "", "note": note, "contact": contact,
                            "time": time.strftime("%Y-%m-%d %H:%M:%S"),
                            "ip": payload.get("_ip", "")}, ensure_ascii=False, indent=2))
    try:
        added, already = linkurl.add_to_score_file(path, payload.get("url") or "")
    except ValueError as e:
        return 400, {"ok": False, "err": str(e)}
    except Exception as e:
        return 500, {"ok": False, "err": f"{type(e).__name__}: {e}"}
    if not added:
        return 200, {"ok": True, "file": base, "state": "已存在", "committed": False,
                     "refresh": False, "url": already}
    rel = os.path.join("scores", base)
    rc, out = _git("commit", "-q", "-m", f"link: {base} —— 人工补收录页({len(added)} 条)", "--", rel)
    refresh, why = start_refresh()
    return 200, {"ok": True, "file": base, "state": "已写入", "committed": rc == 0,
                 "git": out[-300:] if rc else "", "url": added,
                 "refresh": refresh, "refresh_msg": why}


def save_tags(payload, note="", contact=""):
    """人工补标签: 校验 -> 留档 -> 写进 scores/<file>.txt 的 usertag -> git commit -> 后台重建。

    与 save_link 同一个套路; 写入实现在 jianpu-db/linkurl.py:add_usertag(唯一一份)。
    只有**分类标签**(`分类/…`)才顺带清掉 `todo=add tags` —— 只补了歌手的话那首仍然缺分类。
    """
    if linkurl is None:
        return 500, {"ok": False, "err": f"找不到 linkurl.py —— JIANPU_DB={DB} 对吗?"}
    base = os.path.basename(payload.get("file") or "")
    if not base or base != (payload.get("file") or "") or not base.endswith(".txt"):
        return 400, {"ok": False, "err": "文件名不合法"}
    path = os.path.join(DB, "scores", base)
    if not os.path.isfile(path):
        return 400, {"ok": False, "err": "语料里没有这份曲谱: " + base}
    raw_tags = [x.strip() for x in re.split(r"[,，、;；]+", payload.get("tags") or "") if x.strip()]
    if not raw_tags:
        return 400, {"ok": False, "err": "标签是空的"}
    os.makedirs(FEEDBACK, exist_ok=True)
    rid = time.strftime("%Y%m%d-%H%M%S") + "-tags-" + _safe(base[:-4], 20)
    with io.open(os.path.join(FEEDBACK, rid + ".json"), "w", encoding="utf-8", newline="\n") as g:
        g.write(json.dumps({"id": rid, "kind": "tags", "file": base, "tags": raw_tags,
                            "note": note, "contact": contact,
                            "time": time.strftime("%Y-%m-%d %H:%M:%S"),
                            "ip": payload.get("_ip", "")}, ensure_ascii=False, indent=2))
    added, existed = [], []
    for t in raw_tags:
        try:
            r = linkurl.add_usertag(path, t, clear_todo=t.startswith("分类/"))
        except ValueError as e:
            return 400, {"ok": False, "err": str(e), "added": added}
        except Exception as e:
            return 500, {"ok": False, "err": f"{type(e).__name__}: {e}", "added": added}
        (added if r == "added" else existed).append(t)
    if not added:
        return 200, {"ok": True, "file": base, "state": "已存在", "committed": False,
                     "refresh": False, "tags": existed}
    rel = os.path.join("scores", base)
    rc, out = _git("commit", "-q", "-m", f"tags: {base} —— 人工补标签({','.join(added)})", "--", rel)
    refresh, why = start_refresh()
    return 200, {"ok": True, "file": base, "state": "已写入", "committed": rc == 0,
                 "git": out[-300:] if rc else "", "tags": added,
                 "refresh": refresh, "refresh_msg": why}


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
    # ①a kind=link / kind=tags: 身份是**文件**而不是曲名 -> 不走"请填曲名"与建谱流程
    if kind == "link":
        return save_link(payload, note, contact)
    if kind == "tags":
        return save_tags(payload, note, contact)
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
    toks = [t for t in src.split() if _is_note(t) or t in ("-", "|", "~")]
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
