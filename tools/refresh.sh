#!/usr/bin/env bash
# 重建整条索引链(人工补了 link= 之后由 server.py 在后台调用, 也可手动跑):
#   曲谱 scores/*.txt --parse_scores--> data.jsonl(+bars) --build_web_data--> 前端索引
# 顺带把 data.jsonl 同步到检索技能目录。
#
# 并发: 带锁(.refresh.lock, 5 分钟过期)。若在跑的时候又有人存了链接, server 会放一个
# `.refresh.pending` 标记 -> 这一轮跑完自动**再来一轮**, 免得那条链接被漏掉。
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"     # jianpu-web/tools
WEB="$(dirname "$HERE")"                  # jianpu-web
ROOT="$(dirname "$WEB")"                  # 语料根
DB="${JIANPU_DB:-$ROOT/jianpu-db}"
SKILL="$ROOT/jianpu2/skills/jianpu-melody-lookup"
LOCK="$WEB/data/.refresh.lock"
PENDING="$WEB/data/.refresh.pending"

for round in 1 2 3; do
  echo "=== refresh 第 $round 轮开始 $(date) ==="
  echo "DB=$DB"
  cd "$DB" && python3 parse_scores.py || { echo "parse_scores 失败"; rm -f "$LOCK"; exit 1; }
  cp "$DB/data.jsonl" "$SKILL/data.jsonl" || echo "! 同步 skill 数据失败"
  cd "$WEB" && python3 tools/build_web_data.py --data "$DB/data.jsonl" --out "$WEB/data"
  rc=$?
  echo "=== refresh 第 $round 轮结束(exit $rc) $(date) ==="
  if [ -f "$PENDING" ]; then
    rm -f "$PENDING"
    echo "检测到新的改动 -> 再来一轮"
    continue
  fi
  break
done
rm -f "$LOCK"
exit 0
