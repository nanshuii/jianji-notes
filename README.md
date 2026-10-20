# 简记

本地优先的笔记与清单应用。所有内容以 Markdown 文件保存在你自己的电脑上，无账号、无云端、断网可用。支持 macOS 和 Windows。

![技术栈](https://img.shields.io/badge/Tauri-2-FFC131) ![前端](https://img.shields.io/badge/React-18-61DAFB)

## 功能

- **笔记**：Markdown 编辑，支持标题、列表、粗体、行内代码、引用、代码块、链接，可切换预览
- **清单**：逐项勾选、回车快速添加、悬停删除、顶部进度条
- **搜索**：标题 + 正文全文搜索
- **置顶**：常用笔记置顶
- **自动保存**：改动 500ms 后落盘；文件先写临时文件再改名，断电不丢数据
- **文件即数据**：一篇笔记 = 一个 `.md` 文件，文件名 = 标题。可用任何编辑器打开、可用 Git 备份

## 数据位置

| 平台 | 目录 |
|---|---|
| macOS | `~/Documents/简记/` |
| Windows | `我的文档\简记\` |

备份 = 复制这个文件夹。

## 常用命令

```bash
npm install        # 安装依赖（首次）

npm run dev        # 浏览器预览（数据存 localStorage，用于快速改界面）
npm run app:dev    # 桌面窗口开发模式（真实读写文件）
npm run app:build  # 打包当前平台的安装包
```

打包产物位置：

- macOS：`src-tauri/target/release/bundle/dmg/简记_0.1.0_x64.dmg`（Intel 为 `x64`，Apple Silicon 为 `aarch64`）
- Windows：`src-tauri/target/release/bundle/nsis/简记_0.1.0_x64-setup.exe`

## 在 VSCode 里调试

项目自带 `.vscode/` 配置，打开目录即可用，无需手动建。

**调试面板（⌘⇧D）里四个配置：**

| 配置 | 作用 | 依赖 |
|---|---|---|
| 前端：Chrome 调试 | 自动起 vite，Chrome 里打断点调 `src/` 下所有 tsx/ts | 需装 Chrome |
| 前端：只启动不调试 | 同上但不开调试器，纯预览界面 | 需装 Chrome |
| Tauri：调试桌面窗口（Rust） | 附加 lldb，可断点调 `lib.rs` 里的文件读写 | 需装 CodeLLDB 扩展 |
| Tauri：附加到已运行的应用 | 调试器 attach 到现成的进程 | 需装 CodeLLDB 扩展 |

前两个配置会自动启动 `vite: dev` 任务，不用先开终端。桌面模式的 Rust 调试建议先用 `npm run app:dev` 跑起来，再用「附加到已运行的应用」挂上去，比直接 launch 更稳。

**任务面板（⌘⇧B 或 终端 → 运行任务）：**

- `vite: dev` — 前端开发服务器
- `tauri: dev` — 完整桌面应用热更新（tauri 自己会起 vite，不要再叠加前一个）
- `检查类型` — `tsc --noEmit`，改完代码先跑这个
- `打包 macOS 应用` — 出 .app 与 .dmg

首次打开会提示装推荐扩展（rust-analyzer、CodeLLDB、Tauri）。rust-analyzer 已在用，CodeLLDB 只有需要调 Rust 时才装。

## 打包 Windows 版

Windows 安装包必须在 Windows 上编译（Tauri 不支持交叉编译）。两种方式：

1. **本地打包**：在一台装有 [Rust](https://rustup.rs) + Node 18+ 的 Windows 电脑上，把项目复制过去，运行 `npm install && npm run app:build`
2. **GitHub Actions 自动打包**：把仓库推到 GitHub，工作流 `.github/workflows/build.yml` 会同时在 Windows 和 macOS 上构建，产物在 Actions 页面的 Artifacts 里下载

## 项目结构

```
notes-app/
├── src/                  # 前端（React + TypeScript）
│   ├── App.tsx           # 界面与交互
│   ├── storage.ts        # 存储适配层：桌面走 Tauri 命令，浏览器降级 localStorage
│   ├── types.ts          # 笔记模型 + front-matter 解析
│   └── markdown.ts       # 轻量 Markdown 渲染
├── src-tauri/            # 桌面壳（Rust）
│   ├── src/lib.rs        # 文件读写命令（list/save/delete）
│   └── tauri.conf.json   # 窗口与打包配置
└── .github/workflows/    # 双平台自动打包
```

## 改界面的入口

- 颜色、字号、布局：`src/styles.css` 顶部的 CSS 变量
- 默认主题色：`--accent`（现在是陶土橙 `#c05f3a`）
- 数据目录名：`src-tauri/src/lib.rs` 里的 `dir_of` 函数

## 快捷键

| 按键 | 作用 |
|---|---|
| `⌘N` | 新建笔记 |
| `⌘F` | 搜索 |
| `⌘S` | 立即保存 |
