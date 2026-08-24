# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **核心用户：小团队（2–5 人）**，通过 Cloudflare 云端部署共享一块任务看板协作（同一共享密码 + 各自 actor 名区分归属）。
- **次要用户：AI 深度个人用户**，让 AI 助手（Mana / Claude Code / Codex）通过 taskctl 代为管理任务；人主要看桌面挂件，偶尔干预。
- **典型场景**：用户在 AI 会话中产出任务（"帮我建个任务跟踪 X"），AI 经 taskctl 落库；人通过屏幕角落的置顶挂件随时扫一眼进度，用内建表单快速补任务；团队场景下各成员的 actor 名在看板上区分归属。

## Product Purpose

dashi-taskboard 的本地化封装与增强。让任务追踪成为 AI 工作流的原生一环：AI 建、人看、双方流转。成功 = 用户不再为"记任务"单独开一个工具，AI 会话里的待办自动出现在桌面上，且人机对同一任务的操作有明确协议（认领 → 推进 → 评审 → 完成）互不打架。

## Positioning

**人机共享任务协议**。上游产品把 AI（Codex Agent）和用户当作同一看板的两类 actor，本封装补齐了纯客户端桌面挂件与 AI 直连链路——区别于普通 GTD 工具的核心机制是：任务归属（thread-id / actor）、乐观并发（version）保证 AI 与人不覆盖彼此的操作。邻近的个人待办工具无法诚实地宣称这一点。

## Operating Context

- **运行形态**：Windows 桌面（Tauri 2 置顶无边框挂件，280×48 胶囊 ↔ 360×520 面板 ↔ 详情/评论 三级），日常无 Node 服务、无端口、无浏览器。
- **三级信息架构**（安静 → 召唤 → 深潜，2026-08-24 拍板）：L1 胶囊（常驻扫一眼）→ L2 挂件面板（列表/新建/流转）→ L3 深看。L3 双轨：
  - **L3-本机（零依赖，主路径）**：挂件面板内做任务详情 + 评论（数据全在 SQLite，Rust 直连）——单机用户"深看"闭环，不依赖任何服务；
  - **L3-全版（依赖 Node，后手）**：挂件"全版看板"入口 → 自动拉起 server（经 taskboard.py，进程属主不分裂）+ **Tauri 第二窗口内嵌**（1280×800 可缩放）；Node/源码缺失时挂件内 toast 降级提示。**已实现**（2026-08-24，代码链路验证通过）。
- **三种模式**：① 纯客户端（挂件 Rust 直连 SQLite + taskctl Node 直连，同库 WAL 并发）——**单机全功能是承诺**；② server 模式（**降级定位**：云端登录 companion + 上游能力超集/全版看板的访问层，个人日常不依赖）；③ 云端模式（Cloudflare Workers + D1，团队共享正解）。
- **数据**：单一 `taskboard.sqlite`，三模式同库互通；`CODEX_TASKBOARD_DATA_DIR` 决定位置（默认 `<repo>/.data`）。
- **AI 侧协议**：SKILL.md 定义的工作流——开工前 `issue get` + `comment list`、认领用 `--if-version` 乐观锁、完成后评论 + 流转 `in_review`、仅用户明确接受才 `done`；每个写操作须带稳定 `--thread-id`。
- **任务模型**（上游定义）：7 状态（backlog → todo → in_progress → in_review → done，另有 blocked / canceled）、5 优先级、标签、截止日期、评论、活动流、（云端/服务模式下）关联与附件。

## Capabilities and Constraints

- **已实现**：纯客户端挂件（内嵌页面 + rusqlite 数据层 + 内建新建表单 + 流转按钮 + 5 秒轮询感知外部写入）；taskctl 本地直连（输出契约与上游完全一致：schemaVersion:2 JSON、退出码 0/2/3/4/5）；`clean --purge-data` 等清理边界；本地云端部署已验证可行。
- **未实现 / 待决**：
  - 云端模式未封装进 skill（`cloud login` 的交互式密码输入需绕行底层 API，尚无 `cloud-login` 子命令）；
  - taskctl 本地模式不支持 cloud / relation / attachment（relation 本地直连技术上可行，待需求确认）；
  - 挂件 L3-本机（详情 + 评论）——**已实现并实机验证**（2026-08-24：点任务条目进入详情视图，全字段 + 评论列表 + 评论输入；agent 发言强调色区分人机）；
  - 挂件 L3-全版入口——**已实现**（2026-08-24：头部图标 → taskboard.py 拉起 server → 第二窗口内嵌；UI 点击路径待用户实测）；
  - 上游云端无账号体系与群组权限（共享密码信任模型），"同实例内按人隔离" 需二次开发，定位为**不在当前范围**。
- **硬约束**：不修改 `upstream/` 任何文件（上游更新可无痛同步）；挂件页面为编译期嵌入（改前端需 build-widget → cargo build 两步）；node:sqlite 要求 Node ≥ 22.5；Windows 平台（进程锁、文件句柄行为均按 Windows 语义处理）。

## Brand Commitments

- 名称：dashi-taskboard（挂件窗口标题「dashi-taskboard 挂件」）。
- 视觉基调（用户确认）：**安静的桌面伴侣**——常驻屏幕角落不打扰：小体积、低饱和、信息密度克制，参照 macOS 菜单栏小组件的气质。
- 现有暗色 token 体系（`widget/web/src/styles/tokens.css`：灰阶 + 蓝紫强调 + 语义色三层结构）是既成事实的视觉语言，后续迭代在其上精进而非推翻。

## Evidence on Hand

- 可运行产物：挂件 exe（已构建）、`cli/taskctl-local.mjs`、`skill/taskboard.py` 全链路经端到端验证（纯客户端 / WAL 并发 / 409 冲突重试 / 云端部署均实测通过，验证记录见会话）。
- 文档：`README.md`（架构总览）、`skill/SKILL.md`（AI 工作流协议）、上游 `docs/cloud-collaboration.md`（云端部署）。
- 无真实用户数据 / 截图 / 用户证言——后续界面工作不得虚构这些。

## Product Principles

1. **AI 是第一等用户**：界面与协议先服务"AI 建任务、人扫进度"的主循环；为 AI 设计的能力（taskctl 契约、thread-id、乐观锁）不可为人肉便利而弱化。
2. **安静常驻**：挂件默认隐于屏幕角落，信息密度做减法；用户注意力是稀缺资源，只在异常（逾期、阻塞）时允许打破安静。
3. **同库不分裂**：三种模式（纯客户端 / server / 云端）共享同一数据结构，任何新功能先回答"在哪个模式下可用、数据是否互通"。
4. **上游为友不为敌**：一切增强通过外层封装实现，upstream 保持只读快照；能复用上游数据层的（如 taskctl-local）绝不重写。
5. **可撤销的试用心态**：不装全局依赖、不写系统配置、清理边界清晰——用户敢随时删掉重来，这本身就是产品信任的一部分。
