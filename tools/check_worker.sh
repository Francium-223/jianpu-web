#!/usr/bin/env bash
# 把 Cloudflare Worker **真跑一遍**（wrangler dev --local = 真 workerd + 本地 R2）：
#   静态资源 / `/s/<id>` 深链回退 / `/img/*` 从 R2 取图 / 越界不泄露 / 没配后端时投稿的提示。
# 为什么值得单列: 部署到 Cloudflare 之前, 这些路径在本机就能验; 不然只能"推上去看运气"。
#
#     bash tools/check_worker.sh          # 没装 wrangler 就跳过（npm install 一下就有）
#     PORT=8899 bash tools/check_worker.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
WEB="$(dirname "$HERE")"
cd "$WEB"
PORT="${PORT:-8787}"
LOG="$(mktemp)"
STOPPED=0
fail=0
ok() { printf '%s %s\n' "$([ "$1" = 1 ] && echo '✓' || echo '✗')" "$2"; [ "$1" = 1 ] || fail=1; }

if [ ! -x node_modules/.bin/wrangler ]; then
  echo "跳过: 没装 wrangler（在 jianpu-web 里跑 npm install 就有了）"
  exit 0
fi

node tools/build_dist.mjs >/dev/null || { echo "!! dist 构建失败"; exit 1; }

cleanup() {
  [ "$STOPPED" = 1 ] && return
  STOPPED=1
  # ⚠ 必须杀**整个进程组**: `npx wrangler dev` 底下是 npx → node(cli.js) → workerd 三层,
  #   只 kill $! 或只 pkill -P $! 都会留下 workerd 占着 8787 和本地 R2 的 sqlite,
  #   下一次跑就"起不来"（实测踩过）。setsid 让它自成进程组, 于是 kill -- -PGID 一把清干净。
  kill -- "-$WPID" 2>/dev/null
  wait "$WPID" 2>/dev/null
}
trap cleanup EXIT

setsid npx wrangler dev --port "$PORT" --local > "$LOG" 2>&1 &
WPID=$!            # setsid 之后 $! 就是新进程组的组长, cleanup 用 -$WPID 杀全组
for i in $(seq 1 60); do
  grep -q "Ready on" "$LOG" && break
  kill -0 "$WPID" 2>/dev/null || { echo "!! wrangler dev 起不来:"; tail -5 "$LOG"; exit 1; }
  sleep 1
done
grep -q "Ready on" "$LOG" || { echo "!! 等不到 Ready:"; tail -5 "$LOG"; exit 1; }
echo "wrangler dev 就绪 (:$PORT), dist 已重建"

code() { curl -s -m 20 -o /tmp/_cw.out -w '%{http_code}' "http://127.0.0.1:$PORT$1"; }

echo "--- 静态资源与深链 ---"
for p in "/" "/static/app.js" "/static/style.css" "/data/songs.jsonl.gz" "/data/stats.json"; do
  c=$(code "$p"); ok "$([ "$c" = 200 ] && echo 1 || echo 0)" "$p -> $c"
done
c=$(code "/s/qupu123-313063")
grep -q 'id="tune"' /tmp/_cw.out && ok 1 "/s/<id> 深链 -> $c 且是 index.html（SPA 回退生效）" \
                                || ok 0 "/s/<id> 深链没有回退到 index.html"

echo "--- API ---"
c=$(code "/api/health")
grep -q '"ok":true' /tmp/_cw.out && ok 1 "/api/health -> $c $(cat /tmp/_cw.out)" || ok 0 "/api/health -> $c"
c=$(curl -s -m 20 -o /tmp/_cw.out -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
     -d '{"kind":"new","title":"x","score":"12345"}' "http://127.0.0.1:$PORT/api/submit")
[ "$c" = 503 ] && grep -q '投稿后端' /tmp/_cw.out && ok 1 "没配后端时 /api/submit -> 503 且说人话" \
                                                 || ok 0 "没配后端时 /api/submit -> $c $(head -c 120 /tmp/_cw.out)"

echo "--- 越界 / 非图 ---"
c=$(code "/img/%2e%2e/wrangler.jsonc")
grep -q r2_buckets /tmp/_cw.out && ok 0 "越界路径泄露了配置文件!" || ok 1 "越界路径没泄露配置（$c, URL 规范化后走 SPA 回退）"
c=$(code "/img/images/x.txt"); ok "$([ "$c" = 404 ] && echo 1 || echo 0)" "非图扩展名 -> $c"

echo "--- /img/* 从 R2 取图（把样本两页传进本地桶） ---"
read -r S D F1 F2 < <(python3 - <<'PY'
import gzip, json
imgs = {}
for ln in gzip.open('data/images.jsonl.gz', 'rt', encoding='utf-8'):
    r = json.loads(ln); imgs[r['s']] = r
for ln in gzip.open('data/songs.jsonl.gz', 'rt', encoding='utf-8'):
    r = json.loads(ln)
    s = r.get('s')
    if s in imgs and len(imgs[s]['pg']) >= 2 and not imgs[s]['drv']:
        print(s, imgs[s]['d'], imgs[s]['pg'][0][0], imgs[s]['pg'][1][0]); break
PY
)
if [ -z "${D:-}" ]; then
  ok 0 "挑不出有原图的样本"
else
  for f in "$F1" "$F2"; do
    npx wrangler r2 object put "jianpu-images/$D/$f" --file "/home/caesium-132/jianpu/$D/$f" --local >/dev/null 2>&1
  done
  Q=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$D/$F1")
  c=$(code "/img/$Q")
  ct=$(curl -s -m 20 -o /tmp/_cw.jpg -w '%{content_type}' "http://127.0.0.1:$PORT/img/$Q")
  [ "$c" = 200 ] && [ "${ct#image/}" != "$ct" ] && [ "$(stat -c%s /tmp/_cw.jpg)" -gt 1000 ] \
    && ok 1 "/img/<key> -> $c $ct $(stat -c%s /tmp/_cw.jpg)B" \
    || ok 0 "/img/<key> -> $c $ct $(stat -c%s /tmp/_cw.jpg)B"
  cc=$(curl -s -m 20 -D- -o /dev/null "http://127.0.0.1:$PORT/img/$Q" | grep -i '^cache-control' | tr -d '\r')
  ok "$(echo "$cc" | grep -q 'max-age=604800' && echo 1 || echo 0)" "原图带长缓存头（$cc）"
fi

echo "--- 真浏览器走 Worker（有 geckodriver 才跑） ---"
if command -v geckodriver >/dev/null 2>&1 || command -v firefox.geckodriver >/dev/null 2>&1; then
  # 只跑一次（要 ~40 秒）: 输出留档, 退出码判成败
  if python3 tools/browser_check.py spa "http://127.0.0.1:$PORT" > /tmp/_cw_browser.out 2>&1; then
    ok 1 "浏览器交互自检（Worker 上）通过"; tail -4 /tmp/_cw_browser.out | sed 's/^/    /'
  else
    ok 0 "浏览器交互自检（Worker 上）失败"; tail -8 /tmp/_cw_browser.out | sed 's/^/    /'
  fi
else
  echo "    (跳过: 没装 geckodriver)"
fi

echo
[ "$fail" = 0 ] && echo "Worker 本地自检 通过" || echo "Worker 本地自检 失败（见上面 ✗）"
exit $fail
