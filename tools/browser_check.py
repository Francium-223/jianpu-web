# -*- coding: utf-8 -*-
"""用真浏览器(geckodriver + firefox)把页面**看**一遍 —— 只依赖标准库, 自己起停 geckodriver。

为什么需要: `check_*.mjs` 用的是假 DOM, 它们能证明"HTML 里有 <img src=…>", 但证明不了
"浏览器真的把图取回来、排版没塌、点一下能跳过去"。2026-09-24 加「每谱一页」时就踩到过:
假 DOM 全绿, 而真浏览器里 `/s/<id>` 深链**整片白屏** —— 因为 index.html 用的是相对路径
`./static/app.js`, 在深链上被解析成 `/s/static/app.js`(404)。这种错只有真浏览器能抓到。

用法:
    python3 tools/browser_check.py shot <url> <出图.png> [--wait-js 条件] [--size 1440x1100] [--scroll 0,1500]
    python3 tools/browser_check.py spa  [base]        # 深链/应用内跳转/后退/刷新 的交互自检
    python3 tools/browser_check.py subdir             # 子目录部署(有 SPA 回退的静态主机)
    python3 tools/browser_check.py ghpages            # **GitHub Pages** 规矩: 子路径 + 404.html(状态 404)

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


def sample_tune():
    """从本地索引里挑一首样本谱页: (tune_id, source, 原图页数)。挑不出来就 None。

    页数已经不用了(前端不再显示原图), 但留着方便日志里看出这条谱在盘上有没有扫描件。
    """
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
    sample = sample_tune()
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
        href = d.js("var a=document.querySelector('#out a.title.tune'); return a?a.getAttribute('href'):''")
        ok(bool(href) and "/s/" in href, "卡片标题就是「本谱一页」链接: " + (href or "(没有)"))
        if href:
            d.js("document.querySelector('#out a.title.tune').click(); return 1")
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
        print(f"  样本谱页: /s/{tid} (source={src})")
        d.open(base + "/s/" + tid)
        ok(d.wait_js("document.querySelector('#tune pre.sheet') ? 1 : 0", 40),
           f"谱页 /s/{tid} 渲出 verbatim 原文")
        ok(d.js("return document.querySelectorAll('#tune img').length") == 0,
           "谱页里没有 <img>（「原图」那一栏已按用户口径去掉）")
        ok(d.js("return document.querySelectorAll('#tune .meta tr').length") > 5,
           "元数据表有内容")
        ok(d.js("return document.querySelector('#tune pre.sheet').innerHTML.indexOf('<span')") < 0,
           "原文块是纯文本(没有注入小节线/标黑)")
        ok(d.js("return document.querySelector('#tune pre.sheet').textContent.length") > 20,
           "原文块里有正文")
        # 刷新后仍应渲出这一页（深链可用）
        d.call("POST", "/session/%s/refresh" % d.sid, {})
        ok(d.wait_js("document.querySelector('#tune pre.sheet') ? 1 : 0", 40),
           "刷新谱页仍然是这一页(深链可用)")
    finally:
        d.close()
    return 0


def cmd_spa(a):
    """深链 -> 应用内跳转 -> 后退 -> 刷新: 「每谱一页」的交互自检(真浏览器)。"""
    base = (a.base or "http://127.0.0.1:8770").rstrip("/")
    sample = sample_tune()
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
        # "找不到？欢迎补充。" -> 结果区最前面一行, 点它应预选『推荐收录』并把刚敲的数字填进 sscore
        ok(d.js("return document.querySelectorAll('#out p.nf a.nf-add').length") == 1,
           "结果最前面有「找不到？欢迎补充。」")
        d.js("var a=document.querySelector('#out a.nf-add'); if(a){a.click();} return 1")
        ok(d.js("return (document.getElementById('skind')||{}).value") == "new",
           "点「欢迎补充」预选『推荐收录』")
        _sc = (d.js("return (document.getElementById('sscore')||{}).value") or "").replace(" ", "")
        _q = (d.js("return (document.getElementById('q')||{}).value") or "").replace(" ", "")
        ok(_sc == _q and _sc != "", "并把刚敲的数字填进投稿表单: " + _sc + "（查询是 " + _q + "）")
        # 没命中时也要有这一行（用户要的是"结果最前面"，空结果同样是结果）
        d.js("var q=document.getElementById('q'); q.value='77717771777177';"
             "document.getElementById('form').dispatchEvent(new Event('submit',{cancelable:true})); return 1")
        time.sleep(2.5)
        ok(d.js("return document.querySelectorAll('#out p.nf a.nf-add').length") == 1,
           '查不到时结果区最前面也有这一行')

        href = d.js("var a=document.querySelector('#out a.title.tune'); return a?a.getAttribute('href'):''")
        ok(bool(href) and "/s/" in href, "卡片标题就是「本谱一页」链接: " + (href or "(没有)"))
        if href:
            d.js("document.querySelector('#out a.title.tune').click(); return 1")
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
        print(f"  样本谱页: /s/{tid} (source={src})")
        d.open(base + "/s/" + tid)
        ok(d.wait_js("document.querySelector('#tune pre.sheet') ? 1 : 0", 40),
           f"谱页 /s/{tid} 渲出 verbatim 原文")
        ok(d.js("return document.querySelectorAll('#tune img').length") == 0,
           "谱页里没有 <img>（「原图」那一栏已按用户口径去掉）")
        ok(d.js("return document.querySelectorAll('#tune .meta tr').length") > 5,
           "元数据表有内容")
        ok(d.js("return document.querySelector('#tune pre.sheet').innerHTML.indexOf('<span')") < 0,
           "原文块是纯文本(没有注入小节线/标黑)")
        ok(d.js("return document.querySelector('#tune pre.sheet').textContent.length") > 20,
           "原文块里有正文")
        # 刷新后仍应渲出这一页（深链可用）
        d.call("POST", "/session/%s/refresh" % d.sid, {})
        ok(d.wait_js("document.querySelector('#tune pre.sheet') ? 1 : 0", 40),
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
    sample = sample_tune()
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
        ok(d.js("return document.querySelectorAll('#tune pre.sheet').length") == 1,
           "谱页渲出 verbatim 原文块")
        ok(d.js("return document.querySelectorAll('#tune img').length") == 0,
           "谱页里没有 <img>（原图那一栏已去掉）")
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


def cmd_ghpages(a):
    """**GitHub Pages** 自检: 按 Pages 的真实规矩起一个静态服务器, 拿真浏览器走一遍。

    为什么要单独一个模式(而不是复用 subdir): Pages 和"有 SPA 回退的静态主机"**不一样** ——
      * 站点在**子路径** `/jianpu-web/` 下(user.github.io/<repo>/);
      * 未知路径**不**回退到 index.html, 而是发 **`404.html`(HTTP 状态也是 404)**;
      * 没有 Worker: `/api/*` 根本不存在(local build 注入了只读开关)。
    所以这里: 先用 `--target gh` 把产物建到临时目录, 再照上面的规矩服务, 最后验首页/路径深链/
    hash 深链/只读提示。**不装 geckodriver 就跳过**(与 spa/subdir 同样的态度)。
    """
    import http.server
    import subprocess
    import threading
    sample = sample_tune()
    if not sample:
        sys.exit("!! 本地索引里挑不出样本谱页")
    tid = sample[0]
    web = os.path.dirname(HERE)                    # .../jianpu-web
    root = os.path.join(a.tmp, "site")
    site = os.path.join(root, "jianpu-web")        # 站点内容挂在 /jianpu-web/ 下
    shutil.rmtree(root, ignore_errors=True)
    os.makedirs(root, exist_ok=True)
    r = subprocess.run(["node", os.path.join(HERE, "build_dist.mjs"),
                        "--target", "gh", "--out", site],
                       cwd=web, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit("!! 构建 gh 产物失败:\n" + r.stdout + r.stderr)
    if not os.path.isfile(os.path.join(site, "404.html")):
        sys.exit("!! gh 产物里没有 404.html")
    with open(os.path.join(site, "index.html"), "rb") as f:
        index_bytes = f.read()
    with open(os.path.join(site, "404.html"), "rb") as f:
        notfound_bytes = f.read()

    class Pages(http.server.SimpleHTTPRequestHandler):
        """GitHub Pages 的规矩: 找不到的路径发 404.html, 且**状态码是 404**。"""
        def log_message(self, *x):
            pass

        def do_GET(self):
            p = self.translate_path(self.path)
            if os.path.isdir(p):
                p = os.path.join(p, "index.html")
            if not os.path.isfile(p):
                self.send_response(404)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(notfound_bytes)))
                self.end_headers()
                self.wfile.write(notfound_bytes)
                return
            return super().do_GET()

    port = free_port()
    handler = functools.partial(Pages, directory=root)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d/jianpu-web" % port
    print("静态服务器:", base, "(GitHub Pages 模拟: 子路径 + 404.html 回退, 没有 SPA 回退)")
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
        # ⓪ 产物本身: 404.html 必须与 index.html 逐字节相同(构建脚本复制的那一份)
        ok(index_bytes == notfound_bytes, "404.html 与 index.html 逐字节相同")
        ok(b'window.JIANPU_READONLY=true;' in index_bytes,
           "产物里注入了只读开关(静态托管没有写回服务)")
        ok(b'_headers' not in index_bytes and not os.path.exists(os.path.join(site, "_headers")),
           "gh 产物不带 Cloudflare 的 _headers")
        ok(os.path.exists(os.path.join(site, ".nojekyll")), "有 .nojekyll(别让 Jekyll 插手)")

        # ① 首页之子路径: 语料要能从 /jianpu-web/data/ 正确加载
        d.open(base + "/")
        ok(d.wait_js("document.getElementById('status').textContent.indexOf('就绪')>=0", 40),
           "子路径首页能加载并解析语料(%s)" % d.js("return document.getElementById('status').textContent"))
        ok(d.js("return document.getElementById('ro-note') ? 1 : 0") == 1,
           "投稿区上方给了只读提示条")
        # 只读时投稿必须**给句人话**, 而不是发一个必 404 的请求
        d.js("document.getElementById('stitle').value='测试只读'")
        d.js("document.getElementById('sgo').click()")
        ok(d.wait_js("document.getElementById('sstatus').textContent.indexOf('只读')>=0", 10),
           "只读镜像里点投稿 -> 提示'只读'而不是报网络错: %s"
           % d.js("return document.getElementById('sstatus').textContent")[:60])

        # ② 路径深链 `/jianpu-web/s/<id>`: 这一页由 **404.html** 发出来(HTTP 404),
        #    靠 index.html 里那段内联 <base> 把相对路径摆正 —— 这是 Pages 上最容易白屏的一处
        d.open(base + "/s/" + tid)
        ok(renders(), "路径深链由 404.html 发出, 仍能渲出谱页(<base> 生效)")
        ok(d.js("return document.querySelectorAll('#tune pre.sheet').length") == 1,
           "谱页渲出 verbatim 原文块")
        ok(d.js("return document.getElementById('tune').innerHTML.indexOf('加载')<0"),
           "不是卡在'加载中'")
        # ③ hash 深链(纯静态主机最稳的形式)
        d.open(base + "/#/s/" + tid)
        ok(renders(), "hash 深链 #/s/<id> 也能渲出谱页")
        # ④ 从谱页点「回检索」要回到子目录根
        d.open(base + "/s/" + tid)
        renders()
        ok(d.js("return document.querySelector('#tune a.tune').getAttribute('href')").endswith("/jianpu-web/"),
           "「回检索」指向子目录根")
    finally:
        d.close()
        srv.shutdown()
        shutil.rmtree(root, ignore_errors=True)
    print("\nGitHub Pages 部署自检 " + ("通过" if not fail else "失败 %d 项" % fail))
    return 1 if fail else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["shot", "spa", "subdir", "ghpages"])
    ap.add_argument("url", nargs="?", help="shot: 要截的网址; spa: 站点根(默认 127.0.0.1:8770)")
    ap.add_argument("out", nargs="?", default="/tmp/jianpu_page.png")
    ap.add_argument("--wait-js", default="", help="截图前等这个 JS 条件为真")
    ap.add_argument("--size", default="1440x1100")
    ap.add_argument("--scroll", default="", help="逗号分隔的滚动位置, 每个位置截一张")
    ap.add_argument("--tmp", default="/tmp/jianpu-subdir", help="subdir/ghpages 用的临时目录")
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
    if a.mode == "ghpages":
        os.makedirs(a.tmp, exist_ok=True)
        return cmd_ghpages(a)
    a.base = a.url
    return cmd_spa(a)


if __name__ == "__main__":
    sys.exit(main())
