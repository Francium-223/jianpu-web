#!/usr/bin/env bash
# 前端 JS 与 Python 侧的**等价性测试**(一条命令):
#   ① 用 Python 侧的金曲榜harness生成"真实查询片段"(它会打印自己的指标)
#   ② 把这些片段在 JS 侧(static/search.js)重放, 逐条比 Top-1 曲名组
# 为什么重要: 报告的指标出自 Python 侧, 用户实际跑的是浏览器里的 JS —— 同一套代价模型两份实现。
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
WEB="$(dirname "$HERE")"
ROOT="$(dirname "$WEB")"
LIST="${1:-$ROOT/jianpu2/train-work/eval_set_kugou_hualiu_2025.tsv}"
DUMP="$(mktemp)"
echo "=== ① Python 侧生成查询片段($(basename "$LIST")) ==="
python3 "$ROOT/jianpu2/skills/jianpu-melody-lookup/eval_golden.py" \
  --list "$LIST" --lens 15 --errs 0 --dump-queries "$DUMP" | tail -3
echo
echo "=== ② JS 侧重放同一批查询 ==="
node "$HERE/check_js_parity.mjs" "$DUMP"
rm -f "$DUMP"
