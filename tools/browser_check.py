# -*- coding: utf-8 -*-
"""用真浏览器(geckodriver + firefox)把页面**看**一遍 —— 只依赖标准库, 自己起停 geckodriver。

为什么需要: `check_*.mjs` 用的是假 DOM, 它们能证明"HTML 里有 <img src=…>", 但证明不了
"浏览器真的把图取回来、排版没塌、点一下能跳过去"。2026-09-24 加「每谱一页」时就踩到过:
假 DOM 全绿, 而真浏览器里 `/s/<id>` 深链**整片白屏** —— 因为 index.html 用的是相对路径
`./static/app.js`, 在深链上被解析成 `/s/static/app.js`(404)。这种错只有真浏览器能抓到。

用法:
    python3 tools/browser_check.py shot <url> <出图.png> [--wait-js 条件] [--size 1440x1100] [--scroll 0,1500]
    python3 tools/browser_check.py spa  [base]        # 深链/应用内跳转/后退/刷新 的交互自检

依赖: firefox + geckodriver(`firefox.geckodriver` 或 `geckodriver` 在 PATH 里); 没装就别跑,
`tools/check_all.sh` 会自己跳过这一步。
"""

import argparse
import base64
import functools
import gzip
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(os.path.dirname(HERE), "data")


def find_driver():
    for name in ("geckodriver", "firefox.geckodriver"):
        p = shutil.which(name)
        if p:
            return p
    return ""


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class Driver:
    """geckodriver 的 WebDriver 极简客户端(只用得到 session/url/execute/screenshot)。"""

    def __init__(self, width=1440, height=1100, log=os.devnull):
        self.bin = find_driver()
        if not self.bin:
            raise SystemExit("!! 找不到 geckodriver(firefox.geckodriver 或 geckodriver)")
        self.port = free_port()
        self.log = open(log, "wb")
        self.proc = subprocess.Popen([self.bin, "--port", str(self.port)],
                                     stdout=self.log, stderr=subprocess.STDOUT)
        self.w3c = "http://127.0.0.1:%d" % self.port
        for _ in range(120):                       # 等它起来
            try:
                if self.call("GET", "/status")["value"].get("ready"):
                    break
            except Exception:
                time.sleep(0.1)
        else:
            raise SystemExit("!! geckodriver 起不来(用 --log 看它的输出)")
        s = self.call("POST", "/session", {"capabilities": {"alwaysMatch": {
            "browserName": "firefox",
            "moz:firefoxOptions": {"args": ["-headless", "--width=%d" % width,
                                            "--height=%d" % height]}}}})
        self.sid = s["value"]["sessionId"]

    def call(self, method, path, body=None):
        req = urllib.request.Request(
            self.w3c + path, method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read().decode())

    def js(self, script, args=None):
        return self.call("POST", "/session/%s/execute/sync" % self.sid,
                         {"script": script, "args": args or []})["value"]

    def open(self, url):
        self.call("POST", "/session/%s/url" % self.sid, {"url": url})

    def wait_js(self, cond, timeout=40):
        t0 = time.time()
        while time.time() - t0 < timeout:
            if self.js("return (%s) ? 1 : 0;" % cond) == 1:
                return True
            time.sleep(0.4)
        return False

    def shot(self, out, scroll=None):
        if scroll is not None:
            self.js("window.scrollTo(0,%d); return 1" % scroll)
            time.sleep(1.8)
        png = base64.b64decode(self.call("GET", "/session/%s/screenshot" % self.sid)["value"])
        with open(out, "wb") as f:
            f.write(png)
        return len(png)

    def close(self):
        try:
            self.call("DELETE", "/session/%s" % self.sid)
        except Exception:
            pass
        self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()
        self.log.close()


def first_tune_with_images():
    """从本地索引里挑一首**有多页原图**的: (tune_id, source, 页数)。挑不出来就 None。"""
    imgs = {}
    with gzip.open(os.path.join(DATA, "images.jsonl.gz"), "rt", encoding="utf-8") as g:
        for ln in g:
            if ln.strip():
                r = json.loads(ln)
                imgs[r["s"]] = r
    with gzip.open(os.path.join(DATA, "songs.jsonl.gz"), "rt", encoding="utf-8") as g:
        for ln in g:
            if not ln.strip():
                continue
            r = json.loads(ln)
            if r.get("s") in imgs and len(imgs[r["s"]]["pg"]) >= 2 and not imgs[r["s"]]["drv"]:
                return r["id"], r["s"], len(imgs[r["s"]]["pg"])
    return None


def cmd_shot(a):
    w, _, h = a.size.partition("x")
    d = Driver(int(w or 1440), int(h or 1100), a.log)
    try:
        d.open(a.url)
        if a.wait_js:
            print(("✓" if d.wait_js(a.wait_js) else "✗") + " 等待条件: " + a.wait_js)
        else:
            time.sleep(3)
        print("标题:", d.call("GET", "/session/%s/title" % d.sid)["value"],
              "· 页高:", d.js("return document.body.scrollHeight"))
        ys = [int(x) for x in a.scroll.split(",") if x.strip()] or [None]
        for i, y in enumerate(ys):
            out = a.out if i == 0 else a.out.replace(".png", "_y%d.png" % y)
            n = d.shot(out, y)
            print(f"  截图 {out} ({n / 1000:.0f}KB)" + (f"  y={y}" if y is not None else ""))
    finally:
        d.close()
    return 0


def cmd_spa(a):
    """深链 -> 应用内跳转 -> 后退 -> 刷新: 「每谱一页」的交互自检(真浏览器)。"""
    base = (a.base or "http://127.0.0.1:8770").rstrip("/")
    sample = first_tune_with_images()
    if not sample:
        sys.exit("!! 本地索引里挑不出「有多页原图」的样本(先跑 tools/build_web_data.py)")
    tid, src, npages = sample
    d = Driver(log=a.log)
    fail = 0

    def ok(c, m):
        nonlocal fail
        print(("✓ " if c else "✗ ") + m)
        if not c:
            fail += 1

    try:
        # ① 首页: 查一句旋律, 卡片上要有通向谱页的链接, 点了要**不刷新**地跳过去
        d.open(base + "/")
        ok(d.wait_js("document.getElementById('status').textContent.indexOf('就绪')>=0"),
           "首页语料就绪")
        d.js("document.getElementById('q').value='33565653253';"
             "document.getElementById('form').dispatchEvent(new Event('submit',{cancelable:true})); return 1")
        time.sleep(4)
        ok(d.js("return document.querySelectorAll('#out .card').length") > 0, "旋律查歌出卡片")
        href = d.js("var a=document.querySelector('#out a.tune-link'); return a?a.getAttribute('href'):''")
        ok(bool(href) and "/s/" in href, "卡片上有「本谱一页」链接: " + (href or "(没有)"))
        if href:
            d.js("document.querySelector('#out a.tune-link').click(); return 1")
            time.sleep(2.5)
            o = json.loads(d.js("return JSON.stringify({p:location.pathname,"
                                "tune:!document.getElementById('tune').hidden,"
                                "home:!document.getElementById('home').hidden,"
                                "cls:document.body.className,"
                                "img:document.querySelectorAll('#tune figure.page img').length})"))
            ok(o["tune"] and not o["home"], "应用内跳到谱页(没有整页刷新)")
            ok(o["p"] == href, "地址栏变成 " + o["p"])
            ok("tune-mode" in o["cls"], "谱页把版心放宽(tune-mode)")
            d.js("history.back(); return 1")
            time.sleep(1.5)
            ok(d.js("return location.pathname") == "/", "后退回首页")
            ok(d.js("return document.getElementById('out').innerHTML.length") > 200,
               "后退后检索结果还在(单页应用没被重载)")

        # ② 深链 + 刷新: 直接打开一首有原图的谱页, 图要真解码出来, 刷新后还在
        print(f"  样本谱页: /s/{tid} (source={src}, {npages} 页)")
        d.open(base + "/s/" + tid)
        ok(d.wait_js("document.querySelectorAll('#tune figure.page img').length>=2"),
           f"深链 /s/{tid} 出原图")
        ok(d.js("return [...document.querySelectorAll('#tune figure.page img')]"
                ".filter(function(i){return i.naturalWidth>0}).length") > 0,
           "原图真的解码出来了(naturalWidth>0)")
        ok(d.js("return document.querySelectorAll('#tune .score .bar').length") > 0,
           "原文里画了小节线")
        u = d.js("return document.querySelector('#tune figure.page a').getAttribute('href')")
        ok("/img/" in u, "图片链接走 /img/ 前缀: " + u[:70])
        d.call("POST", "/session/%s/refresh" % d.sid, {})
        ok(d.wait_js("document.querySelectorAll('#tune figure.page img').length>=2", 30),
           "刷新谱页仍然是这一页(深链可用)")
    finally:
        d.close()
    print("\n浏览器交互自检 " + ("通过" if not fail else "失败 %d 项" % fail))
    return 1 if fail else 0


def cmd_subdir(a):
    """**子目录部署**自检: 把仓库目录挂在一个静态服务器的子路径下(模拟 user.github.io/jianpu-web/),
    直接打开 `/jianpu-web/s/<id>` —— 这一页必须能加载样式/脚本/数据并渲出原图标签。

    为什么单独测它: index.html 里那段内联 `<base>` 是为了同时满足两件事 —— ① 深链 `/s/<id>` 不白屏;
    ② 部署到子目录不改一行 HTML。这两件事互相拉扯(根绝对路径满足①、相对路径满足②), 只有
    真在子路径下打开一次才能证明 `<base>` 那一手是有效的。
    """
    import http.server
    import threading
    sample = first_tune_with_images()
    if not sample:
        sys.exit("!! 本地索引里挑不出「有多页原图」的样本")
    tid = sample[0]
    web = os.path.dirname(HERE)                    # .../jianpu-web
    mount = os.path.join(a.tmp, "jianpu-web")
    if os.path.islink(mount) or os.path.exists(mount):
        os.remove(mount)
    os.symlink(web, mount)                         # 临时目录里放一个指向仓库的软链

    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *x):
            pass

        def do_GET(self):
            # 单页应用的"深链回退": 找不到的路径返回 index.html —— 模拟服务端挂在子路径下
            # (`/jianpu/s/<id>`) 或有 SPA 回退的静态主机。**没有回退的纯静态主机**要用 hash 形式。
            p = self.translate_path(self.path)
            if os.path.isdir(p):
                p = os.path.join(p, "index.html")
            if not os.path.isfile(p):
                body = open(os.path.join(mount, "static", "index.html"), "rb").read()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            return super().do_GET()

    port = free_port()
    handler = functools.partial(Quiet, directory=a.tmp)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d/jianpu-web" % port
    print("静态服务器:", base, "(子目录部署模拟, 带 SPA 回退)")
    d = Driver(log=a.log)
    fail = 0

    def ok(c, m):
        nonlocal fail
        print(("✓ " if c else "✗ ") + m)
        if not c:
            fail += 1

    def renders():
        return d.wait_js("document.getElementById('tune') && "
                         "document.getElementById('tune').innerHTML.length>200", 40)

    try:
        # ① 路径形式深链 `/jianpu-web/s/<id>`: 这一页**没有**相对路径可依赖(文档在 /s/ 下、
        #    应用根在 /jianpu-web/), 全靠 index.html 里那段内联 <base> 把根摆正。
        d.open(base + "/s/" + tid)
        ok(renders(), "子目录 + 路径深链能渲出谱页(内联 <base> 生效)")
        ok(d.js("return document.styleSheets.length") > 0, "样式表从子目录加载")
        ok(d.js("return document.querySelectorAll('#tune figure.page img').length") > 0,
           "原图标签渲染出来了")
        u = d.js("return (document.querySelector('#tune figure.page img')||{}).src || ''") or ''
        ok("/jianpu-web/img/" in u, "原图地址按**应用根**(不是域名根)拼: " + u[:84])
        ok(d.js("return document.querySelector('#tune a.tune').getAttribute('href')").endswith("/jianpu-web/"),
           "「回检索」指向子目录根")
        # ② hash 形式: 没有 SPA 回退的纯静态主机靠它
        d.open(base + "/#/s/" + tid)
        ok(renders(), "子目录 + hash 深链也能渲出谱页(纯静态托管用这个)")
        # ③ 子目录下的首页
        d.open(base + "/")
        ok(d.wait_js("document.getElementById('status').textContent.indexOf('就绪')>=0", 40),
           "子目录下的首页正常(语料加载完成)")
    finally:
        d.close()
        srv.shutdown()
        os.remove(mount)
    print("\n子目录部署自检 " + ("通过" if not fail else "失败 %d 项" % fail))
    return 1 if fail else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["shot", "spa", "subdir"])
    ap.add_argument("url", nargs="?", help="shot: 要截的网址; spa: 站点根(默认 127.0.0.1:8770)")
    ap.add_argument("out", nargs="?", default="/tmp/jianpu_page.png")
    ap.add_argument("--wait-js", default="", help="截图前等这个 JS 条件为真")
    ap.add_argument("--size", default="1440x1100")
    ap.add_argument("--scroll", default="", help="逗号分隔的滚动位置, 每个位置截一张")
    ap.add_argument("--tmp", default="/tmp/jianpu-subdir", help="subdir 模式挂仓库的临时目录")
    ap.add_argument("--log", default=os.devnull, help="geckodriver 的日志文件")
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    if a.mode == "shot":
        if not a.url:
            sys.exit("用法: browser_check.py shot <url> <out.png>")
        return cmd_shot(a)
    if a.mode == "subdir":
        os.makedirs(a.tmp, exist_ok=True)
        return cmd_subdir(a)
    a.base = a.url
    return cmd_spa(a)


if __name__ == "__main__":
    sys.exit(main())
