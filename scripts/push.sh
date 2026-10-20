#!/bin/bash
# 一键上传：暂存全部改动 -> 提交 -> 自动选可用通道 -> 推送到 GitHub
#
# 用法（在任意目录都能跑，脚本会自己定位项目根）：
#   ./scripts/push.sh                    # 提交信息自动用「更新 2026-10-20 09:30」
#   ./scripts/push.sh 修好了侧栏搜索      # 自定义提交信息
#
# 不用 set -e：否则「没有改动」时 git diff 的正常返回码会让脚本中断。

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

# ---------- 提交 ----------
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

AHEAD="$(git rev-list --count "origin/$BRANCH..$BRANCH" 2>/dev/null || echo 1)"
if [ "$AHEAD" -eq 0 ]; then
  echo "远端已是最新，无需推送"
  exit 0
fi

# ---------- 选一条能连上 GitHub 的通道 ----------
can_reach() {
  if [ -z "$1" ]; then
    curl -s --noproxy '*' --max-time 8 -o /dev/null "https://github.com" 2>/dev/null
  else
    curl -s --proxy "$1" --max-time 8 -o /dev/null "https://github.com" 2>/dev/null
  fi
}

prepare_network() {
  for v in "$https_proxy" "$HTTPS_PROXY"; do
    if [ -n "$v" ] && can_reach "$v"; then
      echo "通道：现有代理 $v"
      return 0
    fi
  done
  if can_reach ""; then
    echo "通道：直连"
    unset https_proxy HTTPS_PROXY http_proxy HTTP_PROXY all_proxy ALL_PROXY
    return 0
  fi
  for p in 7890 7897 1087 10809 8889 8118 6152 1080; do
    if nc -z -G 1 127.0.0.1 "$p" 2>/dev/null && can_reach "http://127.0.0.1:$p"; then
      export https_proxy="http://127.0.0.1:$p" http_proxy="http://127.0.0.1:$p"
      echo "通道：自动选中本地代理 127.0.0.1:$p"
      return 0
    fi
  done
  echo ""
  echo "所有通道都连不上 GitHub（直连超时，本机代理也不通）"
  return 1
}

echo ""
if ! prepare_network; then
  echo "代码已经提交到本地，没有丢。等网络好了再跑一次本脚本就会推上去。"
  exit 2
fi

# ---------- 推送，失败自动重试 ----------
echo "正在推送到 GitHub ..."
PUSH_LOG="$(mktemp)"   # 必须先落文件再判断，否则 `git push | grep` 的退出码会误报成功
ok=0
for i in 1 2 3; do
  if git push -u origin "$BRANCH" >"$PUSH_LOG" 2>&1; then ok=1; break; fi
  if [ "$i" -lt 3 ]; then
    echo "第 $i 次失败，$((i*5)) 秒后重试 ..."
    sleep $((i*5))
  fi
done

if [ "$ok" -eq 1 ]; then
  grep -v '^$' "$PUSH_LOG"
  rm -f "$PUSH_LOG"
  echo ""
  echo "完成：$REMOTE_URL"
  exit 0
fi

grep -v '^$' "$PUSH_LOG"
rm -f "$PUSH_LOG"
echo ""
echo "推送失败（已自动重试 3 次）。常见原因："
echo "  1. 网络不稳 —— 重跑一次本脚本即可，提交已在本地"
echo "  2. 凭据过期 —— 运行 /Users/ledon/.local/bin/gh auth login"
echo "  3. 远端有别人的新提交 —— 先 git pull --rebase"
exit 1
