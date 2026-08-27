---
name: Vibe-TaskDeck
description: 本地试用 Vibe-TaskDeck 任务看板（纯客户端）。用于从 Mana 启动/停止桌面挂件、查询状态，或用 taskctl 本地直连 SQLite 完整操作看板（建任务/认领/改状态/评论）；无需 HTTP 服务与浏览器，运行产物集中在隔离目录，可随时清理。
---

# Vibe-TaskDeck 本地任务看板

这是一个**本地、可撤销**的试用 Skill。它不修改 Unity 业务代码，不安装全局依赖，也不接管已有的 taskboard 进程。

**纯客户端架构**：桌面挂件（Tauri 内嵌页面 + Rust 直连 SQLite）与 taskctl 共用同一数据库文件（WAL 模式），互相同步；不需要启动任何 HTTP 服务，也不打开浏览器。数据默认存于 `<repo>/.data/taskboard.sqlite`（可用 `VIBE_TASKDECK_DATA_DIR` 覆盖）。v0.4.0 起 taskctl 优先走挂件 exe 的 **CLI 双模式**（`taskdeck-widget.exe taskctl ...`，Rust 实现与挂件同库同语义，零 Node 依赖）；exe 未构建时自动回退 Node 脚本（`cli/taskctl-local.mjs`，需 Node 22.5+）。两者输出契约完全一致（schemaVersion:2 JSON + 退出码 0/2/3/4/5）。

## 快速使用

在仓库根目录执行（运行目录可用 `VIBE_TASKDECK_RUNTIME_DIR` 指定）：

```powershell
# 看板操作（taskctl 本地直连 SQLite，无需启动任何服务）
python skill/taskboard.py taskctl project list
python skill/taskboard.py taskctl issue list --project local
python skill/taskboard.py taskctl sync --thread-id my-session   # 冷启动恢复（v0.5.0）

# 桌面挂件（纯客户端：内嵌页面 + 直连 SQLite；需已构建 exe）
python skill/taskboard.py widget        # 启动
python skill/taskboard.py widget stop   # 停止

# 状态与清理
python skill/taskboard.py status
python skill/taskboard.py clean --keep-data
```

已构建 exe 时也可跳过包装器直调（输出契约完全一致；写命令需显式 `--thread-id` 或设 `CODEX_THREAD_ID`）：

```powershell
widget/src-tauri/target/x86_64-pc-windows-msvc/release/taskdeck-widget.exe taskctl issue list
```

`project` 是 `taskctl` 的向后兼容别名，二者等价。

## 前置条件

- 挂件：需要 Rust 工具链构建 exe（见下）。exe 构建后 taskctl 走 exe 双模式，**无 Node 依赖**。
- 仅在 exe 未构建、回退 Node 脚本时需要 Node.js `22.5+`（`node:sqlite`）。

## 桌面挂件（纯客户端）

- `widget`：启动置顶无边框挂件。**不依赖任何服务**：页面在构建期嵌入 exe，数据由 Rust 直连 SQLite 读写。挂件视图：
  - 胶囊（常驻轮播）↔ 大面板（列表/筛选/新建/流转）；点任务条目进入**详情视图**：全字段详情 + 评论列表 + 评论输入（Enter 发送，Esc 返回）。
  - 详情中 agent 发言以强调色标注作者，人机归属一眼可分；评论与 taskctl 同库互通。
  - 大面板头部「全版看板」图标：在**第二窗口**打开全版看板（1280×800 可缩放）——同为挂件内嵌页面（React + Tauri 直连 SQLite），支持七列看板拖拽、详情编辑（Markdown/标签/关联/附件）、筛选搜索、列表视图、归档面板与 undo。秒开，无 Node/upstream 依赖。
- `widget stop`：停止本脚本托管的挂件进程（只杀 widget-state.json 记录的 pid）。
- 挂件感知外部写入（taskctl）靠事件广播 + 约 5 秒轮询兜底；自身写操作即时刷新。

挂件构建（两步，顺序不可颠倒；改动挂件 web 源码后需两步重跑）：

```powershell
cd widget; npm install; npm run build          # 产出 dist/{mini,fullboard}.html（编译期嵌入）
cd src-tauri; cargo build --release --target x86_64-pc-windows-msvc
```

产物：`widget/src-tauri/target/x86_64-pc-windows-msvc/release/taskdeck-widget.exe`（WebView2 静态链接，单 exe 可分发）。

## 数据位置与互通

- 数据库：`VIBE_TASKDECK_DATA_DIR`（taskboard.py 自动设为 `<repo>/.data`）下的 `taskboard.sqlite`；挂件独立运行（不经 taskboard.py）时默认 `%APPDATA%\Vibe-TaskDeck`。
- 双端同库：挂件与 taskctl（exe 直连或 Node 回退）都以 WAL + busy_timeout=5000 打开同一文件，可并发读写。

## 任务状态与优先级

- 状态：`backlog` → `todo` → `in_progress` → `in_review` → `done`；另有 `blocked`（无法继续）、`canceled`（不再继续）。
- 优先级：`none`、`urgent`、`high`、`medium`、`low`。

## 核心工作流（Mana 侧）

1. **冷启动恢复上下文**：会话开始（或隔段时间回来）时，一条 `sync` 即可拿到「我名下有什么、上次离开后双方改了什么、哪些事在等我」（v0.5.0 起游标自动持久化，无需自己记时间戳或 nextSinceId）：

   ```powershell
   taskctl sync --thread-id <my-thread>
   ```

   返回：`mine`（名下任务紧凑列表）+ `attention`（in_review 待评审 / blocked / 逾期）+ `activities`（自上次 sync 以来的增量变更，首跑或 `--reset` 为全量截最近 50 条）+ `nextSinceId`。轮询增量仍可用 `activity list --since-id <nextSinceId>`。之后对要开工的任务再 `issue get` + `comment list` 读全量详情与最新评论（评论可能包含返回的补充要求）。
2. `backlog` 未获用户授权不得开工（v0.5.0 起 CLI 护栏直接拒绝 backlog 流转到 todo 之外，`--force` 为用户已授权时的逃生口）。`todo` 用一条命令原子认领（读版本 → CAS 流转 → 绑定会话三步合一）：

   ```powershell
   taskctl issue claim ID --thread-id <my-thread>
   ```

   已绑定当前会话的 `in_progress` 任务重复 claim 幂等返回（`claimed:false`，不 bump version）；他人持有的任务返回 `CLAIM_CONFLICT`（exit 5，details 带持有者 thread-id）。护栏同样拦截流转其他会话认领的 `in_progress` 任务（`CLAIMED_BY_OTHER`，`--force` 可强制）。挂件 GUI 拖拽不受护栏影响。
3. 完成后加评论说明改动与验证结果，再 `issue move --status in_review`。
4. 仅当用户明确接受后才 `issue move --status done`；无法继续用 `blocked`，不再继续用 `canceled`。
5. 新需求先 `context current` 并查现有任务，优先更新而非重复建卡；不追踪琐碎请求。
6. **向用户汇报**：`taskctl report --thread-id <my-thread>` 一条命令产出汇报素材——名下任务状态汇总（byStatus 七状态计数）+ 逾期/blocked/in_review 清单 + 时间窗内活动流（`--window` 小时数，默认 24；缺省 `--thread-id` 报全看板）。

## taskctl 命令速查（本地模式）

无需启动服务（本地直连 SQLite）。写操作要求 `--thread-id`（经 `taskboard.py` 调用时自动注入，见下方约定）；更新/移动用 `--if-version <version>` 做乐观并发，冲突时重读再处理。`issue list`/`issue get` 支持 `--fields a,b,c` 紧凑投影（27 字段白名单，AI 轮询省 token）。

```powershell
# 上下文与项目
taskctl context current [--cwd PATH]
taskctl project list / create

# 读任务（--fields 紧凑投影；白名单：id,identifier,projectId,title,description,
#   status,priority,labels,sortOrder,threadId,creator*,assignee*,startDate,
#   dueDate,archivedAt,version,createdAt,updatedAt 等 27 字段）
taskctl issue list [--project ID] [--status S] [--archived true|false|all] \
  [--thread-id ID] [--updated-since ISO8601] [--fields id,title,status,version]
taskctl issue get ID [--fields id,status,version]

# 活动流（AI 回执闭环：按会话归属聚合人机双方变更；--since-id 为增量游标）
taskctl activity list [--thread-id ID] [--since-id ACTIVITY_ID]

# 冷启动恢复 + 汇报（v0.5.0；exe 双模式专属，Node 回退报 EXE_ONLY）
taskctl sync --thread-id ID [--archived true|false|all] [--reset]
taskctl report [--thread-id ID] [--window N]   # N 小时，默认 24（1-720）

# 建任务
taskctl issue create --project ID --title TITLE [--description TEXT] \
  [--status S] [--priority P] [--labels a,b] [--thread-id ID] \
  [--start-date YYYY-MM-DD] [--due-date YYYY-MM-DD]

# 更新与流转
taskctl issue update ID [--title/--description/--status/...] [--if-version N]
taskctl issue move ID --status S [--thread-id ID] [--if-version N] [--force]
taskctl issue claim ID [--thread-id ID] [--if-version N] [--force]
taskctl issue archive ID / restore ID

# 关联（type: parent / blocks / blocked_by / related；--issue 为对方任务 id 或 identifier）
taskctl issue relation add ID --type T --issue OTHER_ID [--thread-id ID] [--if-version N]
taskctl issue relation remove ID --type T --issue OTHER_ID [--thread-id ID] [--if-version N]

# 评论
taskctl comment list ISSUE_ID
taskctl comment add ISSUE_ID --body TEXT [--thread-id ID]
taskctl comment update COMMENT_ID --body TEXT --if-version N
taskctl comment delete COMMENT_ID --if-version N

# 附件（upload --task 与 --comment 恰好其一；单文件 ≤10MB；download 落盘到 --output）
taskctl attachment upload --file PATH --task ID | --comment ID [--content-type TYPE]
taskctl attachment download ATTACHMENT_ID --output PATH
```

**本地模式不支持的命令**（报 `UNSUPPORTED_LOCAL`，退出码 2）：`cloud`、`project map`。

关联写语义与挂件同库一致（parent 单父替换 + 环检测、blocks/blocked_by 方向边、related 字典序去重、RELATION_EXISTS / RELATION_NOT_FOUND、双方 version touch）；附件内容存 `<数据目录>/attachments/<UUID>`（与挂件全版看板详情面板完全互通——CLI 传的附件看板可见，反之亦然）。

所有 taskctl 命令均输出 JSON（可加 `--json` 显式声明契约）。退出码：`0` 成功、`2` 非法输入、`3` 环境不可用、`4` API 错误、`5` 冲突。

## thread-id 约定

taskctl 的写操作要求归属到一个会话。**v0.5.0 起经 `taskboard.py` 调用时自动注入稳定 thread-id**，无需每次手传：解析优先级为环境变量（`CODEX_THREAD_ID` / `VIBE_TASKDECK_THREAD_ID`）> `config.json` 的 `threadId` > `runtimeDir/thread-id.json`（首次生成 `mana-<随机>` 并持久化复用）。显式传 `--thread-id` 永远优先；读命令（`issue list` 等）不注入，行为不变。

需要人工管理时仍可显式传 `--thread-id`：同一个 Mana 频道/会话始终使用同一个稳定标识（例如频道名或固定 id），这样看板能把任务绑定到该会话，后续 `issue get` 与 `issue list --thread-id` / `activity list --thread-id` / `sync` 也能按 `threadId` 圈定自己名下的任务与变更流。读操作不要求 thread-id。挂件自身的写操作固定使用 `taskboard-widget`。

## 安装态配置（config.json）

`skill/config.example.json` 复制为同目录 `config.json` 后生效，全部键可省略：`widgetExe`（挂件 exe 路径）、`widgetDir`、`dataDir`（任务数据目录）、`runtimeDir`（运行目录）、`threadId`（固定会话标识）。优先级：显式命令行参数 > 环境变量（`VIBE_TASKDECK_*`）> config.json > 默认值。开发布局（仓库内运行）无需配置。

## AI 身份可配（多 AI 区分）

taskctl 的写操作默认以 `codex-agent` 身份落库（creator/assignee/activity actor）。多个 AI 客户端共用同一看板时，可用环境变量区分身份，活动流与任务详情里即可一眼分清是谁写的：

```powershell
$env:VIBE_TASKDECK_ACTOR_ID = "my-agent"        # actor id（默认 codex-agent）
$env:VIBE_TASKDECK_ACTOR_NAME = "我的助手"       # 显示名（默认 Codex Agent；只设 ID 时回退为该 ID）
```

只影响后续写操作（建卡/更新/流转/归档/评论），不回溯已有记录；不设置时行为与旧版完全一致。

## 清理边界

- 运行目录（日志、PID、状态、thread-id.json）：默认 `<repo>/.tmpfiles/Vibe-TaskDeck`（可用 `VIBE_TASKDECK_RUNTIME_DIR` 覆盖）。`clean --purge` 删除该目录。
- 任务数据：`<repo>/.data/taskboard.sqlite`（或 `VIBE_TASKDECK_DATA_DIR` 指定位置）。**`clean` 默认不删除任务数据**；需要彻底清空任务时用 `clean --purge-data`（删除 taskboard.sqlite / -wal / -shm 及 sync 游标文件 taskctl-sync.json）。
- 绝不删除上游源码、Unity 工程、Git 分支或 worktree；不修改系统服务、注册表、全局 npm 配置或浏览器持久化配置。

“不留痕”仅指本次试用在工程侧的进程、日志、缓存和隔离数据；操作系统或上游服务自身可能保留外部记录。

## 后续迭代

入口脚本按生命周期、taskctl 本地直连、挂件启动和清理策略分层。高频操作（`sync`/`report`/`issue claim`）已封装为独立子命令（v0.5.0）；后续方向：report 输出直接对接消息推送、多会话 thread-id 管理界面化。
