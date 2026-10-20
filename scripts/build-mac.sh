#!/bin/zsh
# 由 launchctl 在用户域执行，绕开当前会话对子进程的删除限制
exec > /tmp/jianji-build2.log 2>&1
cd "/Users/ledon/WorkBuddy/2026-10-19-15-25-56/notes-app" || exit 1
export PATH="$HOME/.cargo/bin:/Users/ledon/.workbuddy/binaries/node/versions/22.22.2-6/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HOME="/Users/ledon"
echo "== start $(date '+%H:%M:%S') =="
npx tauri build --bundles app --config '{"build":{"beforeBuildCommand":"npm run build:local"}}'
echo "EXIT=$?"
