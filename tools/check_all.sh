#!/usr/bin/env bash
# 一键跑完前端/接口的全部自检。用法:
#     bash tools/check_all.sh                  # 打本机 127.0.0.1:8770
#     bash tools/check_all.sh http://127.0.0.1:8903
#     JIANPU_DB=... bash tools/check_all.sh    # 口径跟着 DB 走(check_submit.py 用)
#
# 每组自检都只读(不写语料、不发投稿)。要连真接口一起打, 用:
#     python3 tools/check_submit.py --live <**隔离实例**的 URL>
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
WEB="$(dirname "$HERE")"
URL="${1:-http://127.0.0.1:8770}"
cd "$WEB"
fail=0
run() { echo; echo "=== $* ==="; "$@" || { echo "!! 上面这组失败了"; fail=1; }; }
run python3 tools/check_submit.py
run node tools/check_render.mjs "$URL"
run node tools/check_page.mjs "$URL"
run node tools/check_search.mjs "$URL"
run node tools/check_ui.mjs "$URL"
run node tools/check_live.mjs "$URL"
echo
[ "$fail" = 0 ] && echo "全部自检通过 —— $URL" || echo "有自检失败, 见上面 !! 处"
exit $fail
