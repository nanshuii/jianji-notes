#!/bin/zsh
# 简记 · 一键打包并安装（macOS）
# 双击运行：编译 → 装到「应用程序」→ 重签名 → 打开 → 提交并推送
# 日志同时写到终端和 /tmp/jianji-build.log

cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

echo "======================================"
echo "  简记 · 打包 $(date '+%H:%M:%S')"
echo "======================================"
echo

# 必须走 tauri build：它才会设置 TAURI_ENV_* 让前端资源嵌进二进制。
# 直接用 cargo build 会得到连开发服务器的空壳（表现为白屏）。
npx tauri build --bundles app \
  --config '{"build":{"beforeBuildCommand":"npm run build:local"}}' 2>&1 | tee /tmp/jianji-build.log
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
echo "安装 …"
pkill -f "Contents/MacOS/jianji" 2>/dev/null
sleep 1

# 优先装到系统的「应用程序」，没权限就退回家目录的「应用程序」
DEST="/Applications/简记.app"
if [ ! -w "/Applications" ]; then
  mkdir -p "$HOME/Applications"
  DEST="$HOME/Applications/简记.app"
fi

rm -rf "$DEST"
cp -R "$APP" "$DEST" || { echo "复制失败"; read -r; exit 1; }
codesign --force --deep --sign - "$DEST" >/dev/null 2>&1
if codesign -v "$DEST" 2>/dev/null; then
  echo "签名校验通过"
else
  echo "警告：签名校验未通过，应用可能打不开"
fi

open "$DEST"

echo
echo "重新打 dmg …"
DMG_DIR="src-tauri/target/release/bundle/dmg"
mkdir -p "$DMG_DIR"
DMG="$DMG_DIR/简记_0.1.0_$(uname -m).dmg"
rm -f "$DMG"
hdiutil create -volname "简记" -srcfolder "$APP" -ov -format UDZO "$DMG" >/dev/null 2>&1 \
  && echo "  $DMG" || echo "  dmg 制作失败（不影响使用）"

echo
echo "提交改动到本地仓库 …"
if git add -A && git commit -q -m "构建：$(date '+%Y-%m-%d %H:%M')" 2>/dev/null; then
  echo "已提交"
else
  echo "没有需要提交的改动"
fi
if ./scripts/push.sh >/dev/null 2>&1; then
  echo "已推送到 GitHub"
else
  echo "推送没成功，网络恢复后在项目目录跑 ./scripts/push.sh 即可"
fi

echo
echo "======================================"
echo "  完成，已经打开：$DEST"
echo "  以后从「启动台」或「应用程序」里点「简记」就能用"
echo "======================================"
echo
echo "按回车关闭…"
read -r
