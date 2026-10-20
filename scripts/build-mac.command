#!/bin/zsh
# 简记 · 一键打包并安装（macOS）
# 双击运行即可：用你自己的账户权限编译、装到 ~/Applications、然后打开。

cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

echo "======================================"
echo "  简记 · 打包 $(date '+%H:%M:%S')"
echo "======================================"
echo

npm run app:build 2>&1 | tee /tmp/jianji-build.log
CODE=${pipestatus[1]}

if [ "$CODE" -ne 0 ]; then
  echo
  echo "打包失败（退出码 $CODE）。日志：/tmp/jianji-build.log"
  echo "把窗口里的报错发给助手即可。"
  echo
  echo "按回车关闭…"
  read -r
  exit 1
fi

APP="src-tauri/target/release/bundle/macos/简记.app"
if [ ! -d "$APP" ]; then
  echo "没找到打包结果：$APP"
  read -r
  exit 1
fi

echo
echo "安装到 ~/Applications …"
pkill -f "简记.app/Contents/MacOS/jianji" 2>/dev/null
sleep 1
mkdir -p "$HOME/Applications"
rm -rf "$HOME/Applications/简记.app"
cp -R "$APP" "$HOME/Applications/简记.app"
codesign --force --deep --sign - "$HOME/Applications/简记.app" >/dev/null 2>&1

open "$HOME/Applications/简记.app"

echo
echo "提交改动到本地仓库 …"
if git add -A && git commit -q -m "改成所见即所得编辑：接入富文本编辑器，去掉预览/编辑切换"; then
  echo "已提交"
  if ./scripts/push.sh >/dev/null 2>&1; then
    echo "已推送到 GitHub"
  else
    echo "推送没成功，网络恢复后在项目目录跑 ./scripts/push.sh 即可"
  fi
else
  echo "没有需要提交的改动"
fi

echo
echo "======================================"
echo "  完成，已经打开：~/Applications/简记.app"
DMG=$(ls -t src-tauri/target/release/bundle/dmg/*.dmg 2>/dev/null | head -1)
[ -n "$DMG" ] && echo "  安装包：$DMG"
echo "======================================"
echo
echo "按回车关闭…"
read -r
