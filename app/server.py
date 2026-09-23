# -*- coding: utf-8 -*-
"""极简静态服务器(只读, 零依赖)。

为什么不直接开 index.html: 浏览器对 file:// 下的 ES module + fetch 有限制,
起一个本地 HTTP 服务最省事(也顺便能开 gzip 静态压缩)。

用法:
  py -3.13 app/server.py [端口=8770]
"""
import gzip
import io
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8770
sys.stdout.reconfigure(encoding="utf-8")

MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
        ".jsonl": "application/x-ndjson; charset=utf-8", ".gz": "application/gzip",
        ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon"}


def resolve(path):
    """URL -> 磁盘文件。`/` -> static/index.html; `/data/x` -> data/x; `/static/x` -> static/x"""
    if path == "/" or path == "":
        return os.path.join(ROOT, "static", "index.html")
    rel = path.lstrip("/")
    if not rel.startswith(("static/", "data/")):
        rel = os.path.join("static", rel)
    full = os.path.normpath(os.path.join(ROOT, rel))
    if not full.startswith(ROOT):          # 防目录穿越
        return None
    return full


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s  %s\n" % (self.address_string(), fmt % args))

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        full = resolve(path)
        if not full or not os.path.isfile(full):
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        ext = os.path.splitext(full)[1].lower()
        ctype = MIME.get(ext, "application/octet-stream")
        with open(full, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    print(f"简谱旋律查歌 -> http://127.0.0.1:{PORT}/")
    print(f"根目录 {ROOT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
