# taskboard-skill

dashi-taskboard（Codex Taskboard）任务看板的 Mana 接入封装，**纯客户端架构**：桌面挂件（Tauri 内嵌页面 + Rust 直连 SQLite）与 `taskctl` CLI（Node 直连 SQLite）共用同一数据库文件，无需 HTTP 服务、不打开浏览器；可选启动上游 server 模式获得全版 web 看板（数据同库互通）。

## 仓库结构

```
taskboard-skill/
├── skill/                 # Mana 侧封装（本仓库的核心）
│   ├── taskboard.py       #   挂件启动 / taskctl 本地直连 / server 托管 / 清理入口
│   ├── SKILL.md           #   skill 文档（工作流、命令、状态机）
│   └── config.example.json#   配置示例
├── cli/
│   └── taskctl-local.mjs  # taskctl 本地模式：直连 SQLite（复用上游 TaskboardDatabase）
├── widget/                # 桌面挂件（纯客户端：置顶胶囊 + 展开大挂件 + 任务详情/评论）
│   ├── web/src/           #   挂件页面源码（多文件：tokens.css + 模块化 JS）
│   ├── scripts/build-widget.mjs  # 无依赖构建脚本（src → dist/mini.html，编译期嵌入 exe）
│   └── src-tauri/         #   Tauri 2 壳（内嵌页面 + rusqlite 数据层 + 窗口控制）
└── upstream/              # 上游 Codex Taskboard 源码（第三方，Apache 2.0，不修改）
    └── ...                #   见 upstream/README.md 与 upstream/LICENSE
```

## 来源与授权

- `upstream/` 目录是第三方开源项目 [chuspeeism/dashi-taskboard](https://github.com/chuspeeism/dashi-taskboard)（Codex Taskboard）的源码快照，遵循 **Apache License 2.0**，完整许可证见 [`upstream/LICENSE`](upstream/LICENSE)。
- `skill/`、`cli/`、`widget/` 目录是本文作者为接入 Mana 编写的封装与挂件，不复制或修改上游源码。

## 快速开始

前置条件：Node.js 22.5+（`node:sqlite`）；构建挂件需 Rust 工具链。

```powershell
# 1) taskctl 本地直连（无需任何服务，数据在 <repo>/.data/taskboard.sqlite）
python skill/taskboard.py taskctl project list
python skill/taskboard.py taskctl issue create --project local --title "第一个任务" --thread-id my-session

# 2) 构建并启动桌面挂件（两步顺序不可颠倒；改动挂件 web 源码后需两步重跑）
#    挂件三级视图：胶囊轮播 → 大面板（列表/新建/流转）→ 点任务看详情+评论
node widget/scripts/build-widget.mjs
cd widget/src-tauri; cargo build --release --target x86_64-pc-windows-msvc; cd ../..
python skill/taskboard.py widget

# 3) 可选：server 模式（全版 web 看板，与挂件/taskctl 同库互通，需 upstream npm install）
python skill/taskboard.py --source <绝对路径>\upstream start
```

## skill 命令

| 命令 | 说明 |
| --- | --- |
| `status` | 输出 server 进程、挂件进程、数据目录、日志状态 |
| `widget` / `widget stop` | 启动 / 停止桌面挂件（纯客户端，不依赖服务；内置「全版看板」入口，点击自动拉起 server 并开第二窗口内嵌） |
| `cloud login/status/logout` | 云端协作会话管理（自动拉起 companion server；`--url/--actor-name/--shared-key` 或 `TASKBOARD_CLOUD_*` 环境变量） |
| `taskctl <子命令>` | taskctl 本地直连 SQLite（`project` 为兼容别名）；不支持 cloud/relation/attachment（需 server 模式） |
| `start` | 启动可选的 server 模式（同库）；已可访问时复用 |
| `open` | 启动 server 并打开默认浏览器 |
| `stop` | 停止本 skill 托管的 server 进程 |
| `clean --keep-data` | 停止 server，清 PID/状态/日志，保留数据 |
| `clean` / `clean --purge` | 停止并删除隔离运行目录（不动任务数据，不可逆） |
| `clean --purge-data` | 额外删除任务数据库 `taskboard.sqlite*`（会先停止挂件，不可逆） |

完整工作流、状态机与命令速查见 [`skill/SKILL.md`](skill/SKILL.md)。

## 数据与互通

- 数据库：`CODEX_TASKBOARD_DATA_DIR`（默认 `<repo>/.data`）下的 `taskboard.sqlite`；挂件独立双击运行时默认 `%APPDATA%\dashi-taskboard`。
- 三端（挂件 Rust / taskctl Node / server Node）以 WAL + busy_timeout=5000 打开同一文件，可并发读写；挂件感知外部写入靠约 5 秒轮询。

## 隔离边界

skill 只管理自己写入运行目录 `state.json` / `widget-state.json` 的进程，不按端口扫描或误杀其他进程；清理仅作用于隔离运行目录与显式指定的数据文件，不触碰上游源码、Git 分支、系统服务或全局 npm 配置。

