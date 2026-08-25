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

- **运行形态**：Windows 桌面（Tauri 2 置顶无边框挂件，280×48 胶囊 ↔ 360×520 面板 ↔ 全版看板第二窗口），日常无 Node 服务、无端口、无浏览器。
- **三级信息架构**（安静 → 召唤 → 深潜）：L1 胶囊（常驻扫一眼）→ L2 挂件面板（列表/新建/流转）→ L3 深看。L3 双轨：
  - **L3-本机（零依赖，主路径）**：挂件面板内做任务详情 + 评论（数据全在 SQLite，Rust 直连）——单机用户"深看"闭环，不依赖任何服务；
  - **L3-全版（零依赖，已自研）**：挂件"全版看板"入口 → **Tauri 第二窗口加载本地内嵌页面**（dist/fullboard.html，与挂件同栈 React + Rust 直连 SQLite，秒开）。七列看板拖拽、详情编辑（Markdown/标签/关联/附件）、筛选搜索、列表视图、归档面板、undo。**已实现**（2026-08-25，自研替代旧 Node+upstream 内嵌链路，后者已彻底切断）。
- **纯客户端模式**（挂件 Rust 直连 SQLite + taskctl Node 直连，同库 WAL 并发）——**单机全功能是承诺**。server/云端模式不在当前范围（upstream 仅存语义参考）。
- **数据**：单一 `taskboard.sqlite`；`CODEX_TASKBOARD_DATA_DIR` 决定位置（默认 `<repo>/.data`）。
- **AI 侧协议**：SKILL.md 定义的工作流——开工前 `issue get` + `comment list`、认领用 `--if-version` 乐观锁、完成后评论 + 流转 `in_review`、仅用户明确接受才 `done`；每个写操作须带稳定 `--thread-id`。
- **任务模型**（上游定义）：7 状态（backlog → todo → in_progress → in_review → done，另有 blocked / canceled）、5 优先级、标签、截止日期、评论、活动流、（云端/服务模式下）关联与附件。

## Capabilities and Constraints

- **已实现**：纯客户端挂件（内嵌页面 + rusqlite 数据层 + 内建新建表单 + 流转按钮 + 事件广播 + 5 秒轮询兜底感知外部写入）；自研全版看板（七列拖拽/详情编辑/筛选/列表/归档/undo，React 19 + Tailwind v4 + shadcn 主题层）；**UI 统一精修（2026-08-25）**：全版看板无框自绘标题栏（与挂件同窗口语言）、三端统一暗色细滚动条、详情抽屉 <1280px 浮层化响应式、亮/暗双主题（localStorage > 系统偏好 > 暗色，html 内联防闪）；taskctl 本地直连（输出契约与上游完全一致：schemaVersion:2 JSON、退出码 0/2/3/4/5）；`clean --purge-data` 等清理边界。
- **未实现 / 待决**：
  - taskctl 本地模式不支持 cloud / project map / relation / attachment（关联与附件经挂件全版看板详情面板操作；taskctl 侧封装待需求确认）；
  - AI Chat / Workflow / Gantt / Jira / 云同步 / 多项目（明确不做）；
  - 上游云端无账号体系与群组权限（共享密码信任模型），"同实例内按人隔离" 需二次开发，定位为**不在当前范围**。
- **硬约束**：不修改 `upstream/` 任何文件（上游更新可无痛同步，仅作语义参考）；挂件页面为编译期嵌入（改前端需 npm run build → cargo build 两步）；node:sqlite 要求 Node ≥ 22.5；Windows 平台（进程锁、文件句柄行为均按 Windows 语义处理）。

## Brand Commitments

- 名称：dashi-taskboard（挂件窗口标题「dashi-taskboard 挂件」）。
- 视觉基调（用户确认）：**安静的桌面伴侣**——常驻屏幕角落不打扰：小体积、低饱和、信息密度克制，参照 macOS 菜单栏小组件的气质。
- 现有暗色 token 体系（`widget/web/src/styles/tokens.css`：灰阶 + 蓝紫强调 + 语义色三层结构）是既成事实的视觉语言，后续迭代在其上精进而非推翻。

## Evidence on Hand

- 可运行产物：挂件 exe（已构建）、`cli/taskctl-local.mjs`、`skill/taskboard.py` 全链路经端到端验证（纯客户端 / WAL 并发 / 409 冲突重试 / 全版看板双窗口同步均实测通过，验证记录见会话）。
- 文档：`README.md`（架构总览）、`skill/SKILL.md`（AI 工作流协议）、上游 `docs/cloud-collaboration.md`（云端部署）。
- 无真实用户数据 / 截图 / 用户证言——后续界面工作不得虚构这些。

## Product Principles

1. **AI 是第一等用户**：界面与协议先服务"AI 建任务、人扫进度"的主循环；为 AI 设计的能力（taskctl 契约、thread-id、乐观锁）不可为人肉便利而弱化。
2. **安静常驻**：挂件默认隐于屏幕角落，信息密度做减法；用户注意力是稀缺资源，只在异常（逾期、阻塞）时允许打破安静。
3. **同库不分裂**：挂件与 taskctl 共享同一数据结构，任何新功能先回答"数据是否互通"。
4. **上游为友不为敌**：一切增强通过外层封装实现，upstream 保持只读快照（语义参考）；能复用上游数据层的（如 taskctl-local）绝不重写。
5. **可撤销的试用心态**：不装全局依赖、不写系统配置、清理边界清晰——用户敢随时删掉重来，这本身就是产品信任的一部分。
