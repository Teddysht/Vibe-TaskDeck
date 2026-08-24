---
name: dashi-taskboard
description: 本地试用 dashi-taskboard 任务看板（纯客户端）。用于从 Mana 启动/停止桌面挂件、查询状态，或用 taskctl 本地直连 SQLite 完整操作看板（建任务/认领/改状态/评论）；无需 HTTP 服务与浏览器，运行产物集中在隔离目录，可随时清理。
---

# dashi-taskboard 本地任务看板

这是一个**本地、可撤销**的试用 Skill。它不修改 Unity 业务代码，不安装全局依赖，也不接管已有的 taskboard 进程。

**纯客户端架构**：桌面挂件（Tauri 内嵌页面 + Rust 直连 SQLite）与 taskctl（Node 直连 SQLite）共用同一数据库文件（WAL 模式），互相同步；不需要启动任何 HTTP 服务，也不打开浏览器。数据默认存于 `<repo>/.data/taskboard.sqlite`（可用 `CODEX_TASKBOARD_DATA_DIR` 覆盖）。

## 快速使用

在仓库根目录执行（源码/运行目录可用 `--source`、`DASHI_TASKBOARD_SOURCE`、`DASHI_TASKBOARD_RUNTIME_DIR` 指定）：

```powershell
# 看板操作（taskctl 本地直连 SQLite，无需启动任何服务）
python skill/taskboard.py taskctl project list
python skill/taskboard.py taskctl issue list --project local

# 桌面挂件（纯客户端：内嵌页面 + 直连 SQLite；需已构建 exe）
python skill/taskboard.py widget        # 启动
python skill/taskboard.py widget stop   # 停止

# 云端协作（自动拉起 companion server；团队共享看板场景）
python skill/taskboard.py cloud login --url https://taskboard.example.com --actor-name alice --shared-key <密码>
python skill/taskboard.py cloud status
python skill/taskboard.py cloud logout

# 状态与清理
python skill/taskboard.py status
python skill/taskboard.py clean --keep-data

# 可选：server 模式（全版 web 看板，与挂件/taskctl 同库互通）
python skill/taskboard.py start / stop / open
```

`project` 是 `taskctl` 的向后兼容别名，二者等价。

## 前置条件

- Node.js `22.5+`（taskctl 本地模式依赖 `node:sqlite`；无需在 upstream 执行 `npm install`）。
- 挂件：需要 Rust 工具链构建 exe（见下）。
- server 模式（可选）：需要 upstream 源码目录及 `npm install`（注意本机 npm 配置若为 `omit=dev`，需 `npm install --include=dev` 才能装上 vite 并构建前端 `npm run build:web`）。

## 桌面挂件（纯客户端）

- `widget`：启动置顶无边框挂件。**不依赖任何服务**：页面在构建期嵌入 exe，数据由 Rust 直连 SQLite 读写。挂件三级视图：
  - 胶囊（常驻轮播）↔ 大面板（列表/筛选/新建/流转）；点任务条目进入**详情视图**（L3-本机）：全字段详情 + 评论列表 + 评论输入（Enter 发送，Esc 返回）。
  - 详情中 agent 发言以强调色标注作者，人机归属一眼可分；评论与 taskctl / server 模式同库互通。
  - 大面板头部「全版看板」图标（L3-全版）：点击自动拉起 server 模式并在第二窗口内嵌全版 web 看板（1280×800 可缩放）。需 Node 22.5+ 与 upstream npm install；缺失时挂件内 toast 降级提示。server 进程仍由 taskboard.py 托管（`stop`/`clean` 停止，关全版窗口不停服）。
- `widget stop`：停止本脚本托管的挂件进程（只杀 widget-state.json 记录的 pid）。
- 挂件感知外部写入（taskctl / server 模式）靠约 5 秒轮询；自身写操作即时刷新。

挂件构建（两步，顺序不可颠倒；改动挂件 web 源码后需两步重跑）：

```powershell
node widget/scripts/build-widget.mjs          # 产出 widget/dist/mini.html（编译期嵌入）
cd widget/src-tauri; cargo build --release --target x86_64-pc-windows-msvc
```

产物：`widget/src-tauri/target/x86_64-pc-windows-msvc/release/dashi-taskboard-widget.exe`（WebView2 静态链接，单 exe 可分发）。

## 数据位置与互通

- 数据库：`CODEX_TASKBOARD_DATA_DIR`（taskboard.py 自动设为 `<repo>/.data`）下的 `taskboard.sqlite`；挂件独立运行（不经 taskboard.py）时默认 `%APPDATA%\dashi-taskboard`。
- 三端同库：挂件（Rust）、taskctl-local（Node）、server 模式（Node）都以 WAL + busy_timeout=5000 打开同一文件，可并发读写。
- server 模式（`start`）启动时会设置同一数据目录，浏览器全版看板与挂件/taskctl 数据互通。

## 云端协作（cloud 命令）

- `cloud login --url <云端地址> --actor-name <名字> --shared-key <密码>`：登录云端看板。参数也可用环境变量 `TASKBOARD_CLOUD_URL` / `TASKBOARD_CLOUD_ACTOR` / `TASKBOARD_CLOUD_SHARED_KEY`（AI 场景推荐环境变量，避免密码进命令历史）。
- `cloud status`：查询当前会话（local / cloud 模式、actor 名）。
- `cloud logout`：退出云端模式回到本地数据模式（**不合并**云端与本地数据）。
- 登录后：`taskctl` 的业务请求经本地 companion server 代理到云端（Basic Auth = actor 名 + 共享密码）；云端成为唯一数据源，请求失败会显式报错。
- 注意：登录/登出会**重启 companion server**（配置文件在启动时读取，运行中的 server 不感知变更）。
- 云端部署见上游 `docs/cloud-collaboration.md`（Cloudflare Workers + D1 + R2，共享密码信任模型，适合 2-5 人小团队；无账号体系与按人权限隔离）。

## 任务状态与优先级

- 状态：`backlog` → `todo` → `in_progress` → `in_review` → `done`；另有 `blocked`（无法继续）、`canceled`（不再继续）。
- 优先级：`none`、`urgent`、`high`、`medium`、`low`。

## 核心工作流（Mana 侧）

1. 对已有任务，先 `issue get` + `comment list` 读描述与最新评论，再决定是否开工；评论可能包含返回的补充要求。
2. `backlog` 未获用户授权不得开工。`todo` 可认领时，先用其当前 `version` 执行 `issue move --status in_progress --if-version <version>`，成功后再动手；已 `in_progress` 且绑定当前会话的才可继续。不接管其他会话认领的任务。
3. 完成后加评论说明改动与验证结果，再 `issue move --status in_review`。
4. 仅当用户明确接受后才 `issue move --status done`；无法继续用 `blocked`，不再继续用 `canceled`。
5. 新需求先 `context current` 并查现有任务，优先更新而非重复建卡；不追踪琐碎请求。

## taskctl 命令速查（本地模式）

无需启动服务（本地直连 SQLite）。写操作必须显式传 `--thread-id`（见下方约定）；更新/移动用 `--if-version <version>` 做乐观并发，冲突时重读再处理。

```powershell
# 上下文与项目
taskctl context current [--cwd PATH]
taskctl project list / create

# 读任务
taskctl issue list [--project ID] [--status S] [--archived true|false|all]
taskctl issue get ID

# 建任务
taskctl issue create --project ID --title TITLE [--description TEXT] \
  [--status S] [--priority P] [--labels a,b] [--thread-id ID] \
  [--start-date YYYY-MM-DD] [--due-date YYYY-MM-DD]

# 更新与流转
taskctl issue update ID [--title/--description/--status/...] [--if-version N]
taskctl issue move ID --status S [--thread-id ID] [--if-version N]
taskctl issue archive ID / restore ID

# 评论
taskctl comment list ISSUE_ID
taskctl comment add ISSUE_ID --body TEXT [--thread-id ID]
taskctl comment update COMMENT_ID --body TEXT --if-version N
taskctl comment delete COMMENT_ID --if-version N
```

**本地模式不支持的命令**（报 `UNSUPPORTED_LOCAL`，退出码 2）：`cloud`、`project map`、`issue relation`、`attachment upload/download`。需要这些功能时启动 server 模式（`taskboard.py start`）并使用 upstream 的 `npm run taskctl`。

所有 taskctl 命令均输出 JSON（可加 `--json` 显式声明契约）。退出码：`0` 成功、`2` 非法输入、`3` 环境不可用、`4` API 错误、`5` 冲突。

## thread-id 约定

taskctl 的写操作要求归属到一个会话。Mana 场景没有 `CODEX_THREAD_ID` 环境变量，因此每次写操作都要显式传 `--thread-id`。约定：同一个 Mana 频道/会话始终使用同一个稳定标识（例如频道名或固定 id），这样看板能把任务绑定到该会话，后续 `issue get` 也能按 `threadId` 识别归属。读操作不要求 thread-id。挂件自身的写操作固定使用 `taskboard-widget`。

## 清理边界

- 运行目录（日志、PID、状态）：默认 `<repo>/.tmpfiles/dashi-taskboard`（可用 `DASHI_TASKBOARD_RUNTIME_DIR` 覆盖）。`clean --purge` 删除该目录。
- 任务数据：`<repo>/.data/taskboard.sqlite`（或 `CODEX_TASKBOARD_DATA_DIR` 指定位置）。**`clean` 默认不删除任务数据**；需要彻底清空任务时用 `clean --purge-data`（仅删除 taskboard.sqlite / -wal / -shm）。
- 绝不删除上游源码、Unity 工程、Git 分支或 worktree；不修改系统服务、注册表、全局 npm 配置或浏览器持久化配置。

“不留痕”仅指本次试用在工程侧的进程、日志、缓存和隔离数据；操作系统或上游服务自身可能保留外部记录。

## 后续迭代

入口脚本按生命周期、taskctl 本地直连、挂件启动和清理策略分层。后续可在不改动现有命令的前提下，把高频操作封装为独立子命令（`issue`、`comment`、`report`）；源码与运行目录始终通过配置/参数传入，不复制上游源码。
