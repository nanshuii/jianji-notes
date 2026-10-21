# 简记

本地优先的笔记应用 —— 待办直接写在正文里，和图文混排。所有内容以 Markdown 文件保存在你自己的电脑上，无账号、无云端、断网可用。支持 macOS 和 Windows。

![技术栈](https://img.shields.io/badge/Tauri-2-FFC131) ![前端](https://img.shields.io/badge/React-18-61DAFB)

## 功能

- **笔记本**：把相关笔记归到一个大模块里，磁盘上就是子文件夹（如 `简记/工作/周报.md`）。支持新建、重命名、删除；重命名时整个文件夹连同笔记一起改名
- **笔记**：所见即所得的富文本编辑，不用写 Markdown 标记 —— 标题、粗体、列表、待办、引用、代码块、图片都直接在页面上成型；文件仍以 Markdown 落盘
- **图片**：截图后 `⌘V` 直接粘进正文，或拖入、或用「图片」按钮选文件；图片压缩后内嵌进 `.md`，换电脑、进 Git 都不掉图
- **待办写在正文里**：没有单独的「清单」类型，点工具条 ☑ 或在行首敲 `- [ ] ` 就地生成待办，可跟正文、图片混排；勾掉的加删除线，右上角实时显示「待办 2/4」
- **搜索**：标题 + 正文全文搜索，跨所有笔记本，结果里标注归属
- **置顶**：常用笔记置顶
- **自动保存**：改动 500ms 后落盘；文件先写临时文件再改名，断电不丢数据
- **文件即数据**：一篇笔记 = 一个 `.md` 文件，文件名 = 标题。可用任何编辑器打开、可用 Git 备份
- **可折叠笔记本栏**：左侧笔记本栏可用 `⌘\` 收起，把空间还给编辑器

## 数据位置

| 平台 | 目录 |
|---|---|
| macOS | `~/Documents/简记/` |
| Windows | `我的文档\简记\` |

结构：

```
简记/
├── 欢迎使用简记.md      ← 根目录 = 未分类
└── 工作/                ← 一个笔记本 = 一个子文件夹
    └── 周报.md
```

备份 = 复制这个文件夹。想手工分组，直接在访达里建子文件夹、拖文件进去也行，应用下次启动会自动识别。

## 常用命令

```bash
npm install        # 安装依赖（首次）

npm run dev        # 浏览器预览（数据存 localStorage，用于快速改界面）
npm run app:dev    # 桌面窗口开发模式（真实读写文件）
npm run app:build  # 打包当前平台的安装包
npm run build:local # 仅当本机 `npm run build` 报 esbuild 删临时文件失败时用
```

打包产物位置：

- macOS：`src-tauri/target/release/bundle/dmg/简记_0.1.0_x64.dmg`（Intel 为 `x64`，Apple Silicon 为 `aarch64`）
- Windows：`src-tauri/target/release/bundle/nsis/简记_0.1.0_x64-setup.exe`

> **打包必须用 `npm run app:build`，不要直接 `cargo build --release`。**
> `cargo build` 不会设置 Tauri 的环境变量，前端资源不会被嵌进二进制，程序会去连开发服务器 `localhost:1420`。
> 开发服务器一关，打开就是一片白板 —— 这个坑踩过一次，记在这里。

## 改完代码怎么上传到 GitHub

一条命令，提交信息不填就自动用当前时间：

```bash
./scripts/push.sh                  # 自动提交信息
./scripts/push.sh 修好了侧栏搜索     # 自定义提交信息
```

**VSCode 里更快：按 ⌘⇧B。** 这个快捷键默认就是这个任务，改完代码直接按，终端面板会显示提交了哪些文件、推送结果。

还想要自定义提交信息，用命令面板（⌘⇧P）→ `Tasks: Run Task` → 「一键上传（自定义提交信息）」，会弹输入框。

脚本会自动做四件事：

1. `git add -A` 暂存所有改动
2. 没有改动就跳过，不会产生空提交
3. 自动探测网络通道（现有代理 → 直连 → 本机常见代理端口），哪个能连上 GitHub 用哪个
4. 推送失败自动重试 3 次，仍失败则提示原因，**改动已安全存在本地**

退出码约定：`0` 成功或无需推送，`1` 提交/推送出错，`2` 网络不通（代码已提交本地）。

> 任意项目通用的版本装在 `~/.local/bin/gpush`，在别的仓库里直接敲 `gpush` 即可，行为一致。

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
│   ├── App.tsx           # 界面与交互（三栏：笔记本 / 列表 / 编辑器）
│   ├── storage.ts        # 存储适配层：桌面走 Tauri 命令，浏览器降级 localStorage
│   ├── types.ts          # 笔记模型 + front-matter 解析 + 路径工具
│   ├── markdown.ts       # 轻量 Markdown 渲染
│   ├── manual.md         # 首次启动生成的操作手册（?raw 导入，本身也是 .md）
│   └── styles.css
├── src-tauri/            # 桌面壳（Rust）
│   ├── src/lib.rs        # 文件读写 + 笔记本目录管理（建/改名/删）
│   └── tauri.conf.json   # 窗口与打包配置
├── scripts/push.sh       # 一键提交并推送到 GitHub
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
| `⌘\` | 收起 / 展开笔记本栏 |

## 首次启动

第一次打开会往笔记目录里铺两篇示例：**简记操作手册**（完整功能说明，看完可删）、**欢迎使用简记**（含待办用法示例）。

只在真正的第一次启动时创建 —— 之后即使把笔记全删光，也不会再被塞回来。
