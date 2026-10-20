#!/bin/bash
# 一键上传：暂存全部改动 -> 提交 -> 推送到 GitHub
#
# 用法（在任意目录都能跑，脚本会自己定位项目根）：
#   ./scripts/push.sh                    # 提交信息自动用「更新 2026-10-20 09:30」
#   ./scripts/push.sh 修好了侧栏搜索      # 自定义提交信息
#
# 注意：不用 set -e，否则「没有改动」时 git diff 的正常返回码会让脚本中断。

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || { echo "找不到项目目录"; exit 1; }

REMOTE_URL="$(git remote get-url origin 2>/dev/null)"
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"

if [ -z "$REMOTE_URL" ] || [ -z "$BRANCH" ]; then
  echo "当前目录不是配置好远程仓库的 git 项目：$REPO_ROOT"
  exit 1
fi

MSG="$*"
[ -z "$MSG" ] && MSG="更新 $(date '+%Y-%m-%d %H:%M')"

echo "项目：$REPO_ROOT"
echo "分支：$BRANCH"
echo ""

git add -A

if git diff --cached --quiet; then
  echo "没有新的改动需要提交"
else
  if ! git commit -q -m "$MSG"; then
    echo "提交失败，已中止（改动仍在工作区，没有丢）"
    exit 1
  fi
  echo "已提交：$MSG"
  git --no-pager show --stat --oneline HEAD | tail -n +2 | head -12
fi

# 本地有未推送的提交就推送（包括刚刚这次）
AHEAD="$(git rev-list --count "origin/$BRANCH..$BRANCH" 2>/dev/null || echo 1)"
if [ "$AHEAD" -eq 0 ]; then
  echo "远端已是最新，无需推送"
  exit 0
fi

echo ""
echo "正在推送到 GitHub ..."
if git push -u origin "$BRANCH" 2>&1 | grep -v "^$"; then
  echo ""
  echo "完成：$REMOTE_URL"
else
  echo ""
  echo "推送失败。常见原因："
  echo "  1. 网络不通 —— 重跑一次本脚本即可（提交已存本地，不会丢）"
  echo "  2. 凭据过期 —— 运行 /Users/ledon/.local/bin/gh auth login"
  echo "  3. 远端有别人的新提交 —— 先执行 git pull --rebase"
  exit 1
fi
