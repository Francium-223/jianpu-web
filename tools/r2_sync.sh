#!/usr/bin/env bash
# 把"索引真正用到的原图"（默认 26,416 个 / 5.08GB）传进 R2。
#
#     bash tools/r2_sync.sh --check          # 只体检: 清单在不在、rclone/aws 有没有、远端能不能列
#     bash tools/r2_sync.sh                  # 传（rclone 优先, 断点续传/并发）
#
# 需要先做的一次性准备（都在 Cloudflare 面板/本地, 不需要 sudo）:
#   1) 建桶:      npx wrangler r2 bucket create jianpu-images
#   2) 建 R2 的 S3 凭据: 面板 R2 -> Manage R2 API Tokens -> Create（Object Read & Write）
#      拿到 Access Key ID / Secret Access Key / 账号 ID(Account ID)
#   3) 装一个上传器（二选一）:
#        rclone:  curl -O https://downloads.rclone.org/rclone-current-linux-amd64.zip && unzip -j -d ~/.local/bin
#                 rclone config  → 新建 remote: 类型 s3 / provider Cloudflare / endpoint https://<账号ID>.r2.cloudflarestorage.com
#        aws-cli: pip install --user awscli   （或 python3 -m pip install --user awscli）
#
# 为什么走 S3 API 而不是 `wrangler r2 object put`: 后者一个文件起一个进程（26k 次不现实）,
# 而且它把中文 key **百分号编码**后再存（实测）。S3 API 存的是原样 UTF-8 key —— 规范形式,
# Worker 优先按它查（也兼容百分号编码的那种, 见 worker/index.js）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"        # 工作区根
LIST="${LIST:-$ROOT/_analysis/r2_files.txt}"
BUCKET="${BUCKET:-jianpu-images}"
RCLONE_REMOTE="${RCLONE_REMOTE:-r2}"               # rclone config 里的远端名
AWS_ENDPOINT="${AWS_ENDPOINT:-}"                   # https://<账号ID>.r2.cloudflarestorage.com
CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\n!! %s\n' "$*" >&2; exit 1; }

say "0/3 清单"
[ -f "$LIST" ] || die "没有清单 $LIST —— 先生成: python3 tools/r2_filelist.py"
echo "  $LIST: $(wc -l < "$LIST") 个文件"
du -ch $(head -50 "$LIST" | sed "s|^|$ROOT/|") 2>/dev/null | tail -1 | sed 's/^/  (前 50 个) /'

if command -v rclone >/dev/null 2>&1; then
  say "1/3 rclone 就绪"
  rclone listremotes | sed 's/^/  /'
  rclone listremotes | grep -qx "$RCLONE_REMOTE:" || die "rclone 里没有远端 '$RCLONE_REMOTE'（rclone config 建一个, 或 RCLONE_REMOTE=别的名）"
  say "2/3 远端可读性"
  rclone lsd "$RCLONE_REMOTE:$BUCKET" >/dev/null 2>&1 && echo "  桶 $BUCKET 可读 ✓" || die "读不到 $RCLONE_REMOTE:$BUCKET（桶名/凭据/endpoint 对吗）"
  if [ "$CHECK" = 1 ]; then
    echo; echo "体检通过（--check 不传文件）。真传: bash tools/r2_sync.sh"
    exit 0
  fi
  say "3/3 开始传（断点续传, 已经有的会跳过）"
  time rclone copy "$ROOT" "$RCLONE_REMOTE:$BUCKET" --files-from "$LIST" \
       --transfers 16 --checkers 16 --size-only --stats 30s --stats-one-line -v
  echo "传完。抽查: curl -I https://<你的域名>/img/$(head -1 "$LIST")"
  exit 0
fi

if command -v aws >/dev/null 2>&1 && [ -n "$AWS_ENDPOINT" ]; then
  say "1/3 aws-cli 就绪（endpoint $AWS_ENDPOINT）"
  [ "$CHECK" = 1 ] && { echo "体检通过（--check）"; exit 0; }
  say "2/3 开始传（xargs 8 并发; 不跳已存在, 重复跑会重传）"
  time xargs -a "$LIST" -P 8 -I{} aws s3 cp "$ROOT/{}" "s3://$BUCKET/{}" --endpoint-url "$AWS_ENDPOINT" --only-show-errors
  echo "传完。"
  exit 0
fi

die "没找到上传器。装一个:
  rclone:  curl -O https://downloads.rclone.org/rclone-current-linux-amd64.zip && unzip -j -d ~/.local/bin
  aws-cli: pip install --user awscli   然后 AWS_ENDPOINT=https://<账号ID>.r2.cloudflarestorage.com bash tools/r2_sync.sh"
