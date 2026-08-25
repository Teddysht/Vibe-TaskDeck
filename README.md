# taskboard-skill

dashi-taskboard（Codex Taskboard）任务看板的 Mana 接入封装，**纯客户端架构**：桌面挂件（Tauri 内嵌页面 + Rust 直连 SQLite）与 `taskctl` CLI（Node 直连 SQLite）共用同一数据库文件，无需 HTTP 服务、不打开浏览器。全版看板（七列拖拽/详情编辑/筛选/归档）为挂件第二窗口本地页面，与挂件同栈，无任何 Node server 依赖。

## 仓库结构

```
taskboard-skill/
├── skill/                 # Mana 侧封装（本仓库的核心）
│   ├── taskboard.py       #   挂件启动 / taskctl 本地直连 / 清理入口
│   ├── SKILL.md           #   skill 文档（工作流、命令、状态机）
│   └── config.example.json#   配置示例
├── cli/
│   └── taskctl-local.mjs  # taskctl 本地模式：直连 SQLite（复用上游 TaskboardDatabase）
├── widget/                # 桌面挂件（纯客户端：置顶胶囊 + 展开大挂件 + 全版看板第二窗口）
│   ├── web/src/           #   挂件页面源码（React 19 + Tailwind v4 + shadcn 主题层 + zustand）
│   ├── vite.config.ts     #   双通道构建：mini.html + fullboard.html（编译期嵌入 exe）
│   └── src-tauri/         #   Tauri 2 壳（内嵌页面 + rusqlite 数据层 + 窗口控制）
└── upstream/              # 上游 Codex Taskboard 源码（第三方，Apache 2.0，不修改；仅作语义参考）
    └── ...                #   见 upstream/README.md 与 upstream/LICENSE
```

## 来源与授权

- `upstream/` 目录是第三方开源项目 [chuspeeism/dashi-taskboard](https://github.com/chuspeeism/dashi-taskboard)（Codex Taskboard）的源码快照，遵循 **Apache License 2.0**，完整许可证见 [`upstream/LICENSE`](upstream/LICENSE)。自研全版看板的交互语义（拖拽开缝/undo 栈/筛选）以其为对照源，运行时不依赖它。
- `skill/`、`cli/`、`widget/` 目录是本文作者为接入 Mana 编写的封装与挂件，不复制或修改上游源码。

## 快速开始

前置条件：Node.js 22.5+（`node:sqlite`）；构建挂件需 Rust 工具链。

```powershell
# 1) taskctl 本地直连（无需任何服务，数据在 <repo>/.data/taskboard.sqlite）
python skill/taskboard.py taskctl project list
python skill/taskboard.py taskctl issue create --project local --title "第一个任务" --thread-id my-session

# 2) 构建并启动桌面挂件（两步顺序不可颠倒；改动挂件 web 源码后需两步重跑）
#    挂件视图：胶囊轮播 → 大面板（列表/新建/流转）→ 全版看板（第二窗口，秒开）
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

- 数据库：`CODEX_TASKBOARD_DATA_DIR`（默认 `<repo>/.data`）下的 `taskboard.sqlite`；挂件独立双击运行时默认 `%APPDATA%\dashi-taskboard`。
- 双端（挂件 Rust / taskctl Node）以 WAL + busy_timeout=5000 打开同一文件，可并发读写；挂件感知外部写入靠事件广播 + 约 5 秒轮询兜底。

## 测试

```powershell
cd widget; npm run build        # 产出 dist/{mini,fullboard}.html 双产物
cd tests; node run-all.mjs      # mock 层 10 套件（无头 Chrome + mock Tauri invoke）
# 真实层（连运行中的挂件）：挂件以 WEBVIEW2_CDP_PORT=8490 启动后
WIDGET_CDP_PORT=8490 node run-all.mjs
```

## 隔离边界

skill 只管理自己写入运行目录 `widget-state.json` 的进程，不按端口扫描或误杀其他进程；清理仅作用于隔离运行目录与显式指定的数据文件，不触碰上游源码、Git 分支、系统服务或全局 npm 配置。
