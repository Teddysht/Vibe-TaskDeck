# Vibe-TaskDeck

A compact skill for turning task lists into a clear, actionable board.

**AI-native 纯客户端任务看板**：桌面挂件（Tauri 2 内嵌页面 + Rust 直连 SQLite）与 `taskctl` CLI 共用同一数据库文件，无需 HTTP 服务、不打开浏览器。挂件三视图：胶囊轮播（常驻扫一眼）→ 大面板（列表/新建/流转）→ 全版看板（第二窗口：七列拖拽、详情编辑、筛选搜索、归档面板、undo）。AI 助手经 taskctl 建任务，人看挂件随时扫进度——任务归属（thread-id）与乐观并发（version）保证人机对同一任务的操作互不打架。

## 仓库结构

```
TaskDeck/
├── skill/                 # AI 侧封装（本仓库的核心）
│   ├── taskboard.py       #   挂件启动 / taskctl 本地直连 / 清理入口
│   ├── SKILL.md           #   skill 文档（工作流、命令、状态机）
│   └── config.example.json#   配置示例
├── cli/
│   └── taskctl-local.mjs  # taskctl 本地模式：直连 SQLite
├── widget/                # 桌面挂件（Windows，Tauri 2）
│   ├── web/src/           #   挂件页面源码（React 19 + Tailwind v4 + shadcn 主题层 + zustand）
│   ├── vite.config.ts     #   双通道构建：mini.html + fullboard.html（编译期嵌入 exe）
│   └── src-tauri/         #   Tauri 2 壳（内嵌页面 + rusqlite 数据层 + 窗口控制）
└── PRODUCT.md             # 产品定位与约束
```

## 快速开始

前置条件：Node.js 22.5+（`node:sqlite`）；构建挂件需 Rust 工具链。

```powershell
# 1) taskctl 本地直连（无需任何服务，数据在 <repo>/.data/taskboard.sqlite）
python skill/taskboard.py taskctl project list
python skill/taskboard.py taskctl issue create --project local --title "第一个任务" --thread-id my-session

# 2) 构建并启动桌面挂件（两步顺序不可颠倒；改动挂件 web 源码后需两步重跑）
cd widget; npm install; npm run build; cd src-tauri; cargo build --release --target x86_64-pc-windows-msvc; cd ../..
python skill/taskboard.py widget
```

## skill 命令

| 命令 | 说明 |
| --- | --- |
| `status` | 输出挂件进程、数据目录、运行目录状态 |
| `widget` / `widget stop` | 启动 / 停止桌面挂件（纯客户端，不依赖服务；大面板「全版看板」图标打开第二窗口） |
| `taskctl <子命令>` | taskctl 本地直连 SQLite（`project` 为兼容别名）；不支持 cloud/project map/relation/attachment（关联与附件走挂件全版看板详情面板） |
| `stop` | 停止本 skill 托管的挂件进程 |
| `clean --keep-data` | 停止挂件，清 PID/状态，保留数据 |
| `clean` / `clean --purge` | 停止并删除隔离运行目录（不动任务数据，不可逆） |
| `clean --purge-data` | 额外删除任务数据库 `taskboard.sqlite*`（会先停止挂件，不可逆） |

完整工作流、状态机与命令速查见 [`skill/SKILL.md`](skill/SKILL.md)。

## 数据与互通

- 数据库：`VIBE_TASKDECK_DATA_DIR`（默认 `<repo>/.data`）下的 `taskboard.sqlite`；挂件独立双击运行时默认 `%APPDATA%\Vibe-TaskDeck`。
- 双端（挂件 Rust / taskctl Node）以 WAL + busy_timeout=5000 打开同一文件，可并发读写；挂件感知外部写入靠事件广播 + 约 5 秒轮询兜底。

## 环境变量

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `VIBE_TASKDECK_DATA_DIR` | 任务数据库目录 | `<repo>/.data`（挂件独立运行时 `%APPDATA%\Vibe-TaskDeck`） |
| `VIBE_TASKDECK_RUNTIME_DIR` | 挂件 PID/状态运行目录 | `<repo>/.tmpfiles/Vibe-TaskDeck` |
| `VIBE_TASKDECK_WIDGET_DIR` / `VIBE_TASKDECK_WIDGET_EXE` | 挂件源码目录 / 可执行文件路径 | `widget/` 自动探测 |
| `WEBVIEW2_CDP_PORT` | WebView2 CDP 调试端口（端到端测试用） | 不设 |

## 测试

```powershell
cd widget; npm run build        # 产出 dist/{mini,fullboard}.html 双产物
cd tests; node run-all.mjs      # mock 层 10 套件（无头 Chrome + mock Tauri invoke）
# 真实层（连运行中的挂件）：挂件以 WEBVIEW2_CDP_PORT=8490 启动后
WIDGET_CDP_PORT=8490 node run-all.mjs
```

## Repository hygiene

- Keep credentials, local settings, and generated output out of version control.
- Keep changes focused and document user-visible behavior in this README.
- Use short-lived branches for non-trivial work.
