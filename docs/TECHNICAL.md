# 技术文档

> 面向开发者的架构与实现细节。普通使用指引见 [README](../README.md)。

## 目录

- [架构总览](#架构总览)
- [技术栈](#技术栈)
- [仓库结构](#仓库结构)
- [构建体系](#构建体系)
- [数据层](#数据层)
- [命令层（Tauri invoke）](#命令层tauri-invoke)
- [双窗口与 WebView2 注意事项](#双窗口与-webview2-注意事项)
- [事件同步机制](#事件同步机制)
- [状态通知（系统 toast）](#状态通知系统-toast)
- [筛选语义](#筛选语义)
- [设计令牌与主题](#设计令牌与主题)
- [动效体系](#动效体系)
- [测试体系](#测试体系)
- [环境变量](#环境变量)
- [已知技术债](#已知技术债)

## 架构总览

```
┌─────────────────────────────────────────────────────┐
│ Windows 桌面                                          │
│                                                       │
│  taskdeck-widget.exe（Tauri 2，纯客户端，无服务无端口）│
│  ├─ mini 窗口（280×56 胶囊 ↔ 360×520 大面板）         │
│  └─ fullboard 窗口（≥900×520 全版看板）               │
│        │  invoke（Tauri IPC）                         │
│        ▼                                              │
│  Rust 命令层（commands.rs，19 个命令）                │
│        │  rusqlite（WAL + busy_timeout=5000）         │
│        ▼                                              │
│  taskboard.sqlite ◄──── taskctl-local.mjs（Node）    │
│                        （node:sqlite，同库 WAL 并发）  │
│                              ▲                       │
│  AI 助手（Claude Code / Codex / …）── taskctl CLI ───┘│
└─────────────────────────────────────────────────────┘
```

**核心决策：纯客户端**。挂件 Rust 直连 SQLite、taskctl Node 直连同一文件（WAL 允许多进程并发读写），无 HTTP 服务、无端口、无浏览器。单机全功能是承诺。

**人机协议**：任务归属（`thread-id` / actor）+ 乐观并发（`version` 字段 + `--if-version` 条件更新）保证 AI 与人的写操作互不覆盖，冲突返回 409 语义错误码。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 挂件壳 | Tauri 2（Windows，WebView2 运行时） |
| 前端 | React 19 + TypeScript + Tailwind v4 + shadcn 主题层 + zustand |
| 构建 | Vite 6（双通道：mini + fullboard，`vite-plugin-singlefile` 内联产物） |
| 数据 | SQLite（rusqlite / `node:sqlite` 双端同库） |
| CLI | Node.js ≥ 22.5（`node:sqlite` 要求），无 npm 依赖 |
| 测试 | 无头 Chrome + CDP（mock 层 10 套件 + 真实层）+ `cargo test` |

## 仓库结构

```
TaskDeck/
├── skill/                 # AI 侧封装
│   ├── taskboard.py       #   挂件启动 / taskctl 本地直连 / 清理入口
│   ├── SKILL.md           #   AI 工作流协议（认领→推进→评审→完成）
│   └── config.example.json
├── cli/
│   └── taskctl-local.mjs  # taskctl 本地模式：直连 SQLite，输出契约与上游一致
├── widget/                # 桌面挂件
│   ├── web/src/           #   前端源码（components 挂件 / fullboard 全版看板）
│   │   ├── styles/        #   tokens.css（设计令牌三层）+ widget.css + fullboard.css
│   │   └── fullboard/     #   全版看板模块（board/detail/filters/list/…）
│   ├── vite.config.ts     #   构建通道 1：mini.html（清空 dist）
│   ├── vite.fullboard.config.ts  # 通道 2：fullboard.html（不清空）
│   └── src-tauri/         #   Rust 壳（main.rs 窗口 / commands.rs / db.rs）
├── docs/                  # 文档（本文件）
├── PRODUCT.md             # 产品定位与约束
└── upstream/              # 上游参考（不入库，本地参考实现）
```

## 构建体系

`vite-plugin-singlefile` 不支持多入口（`inlineDynamicImports` 冲突），因此采用**双通道构建**：

```powershell
cd widget
npm run build   # = tsc --noEmit && vite build && vite build -c vite.fullboard.config.ts
```

- 通道 1 产出 `dist/mini.html`（`emptyOutDir: true`）
- 通道 2 产出 `dist/fullboard.html`（`emptyOutDir: false`）
- 两产物经 Tauri `frontendDist` **编译期嵌入 exe**——改前端必须 `npm run build` + `cargo build` 两步重跑

## 数据层

- 单一 `taskboard.sqlite`；位置由 `VIBE_TASKDECK_DATA_DIR` 决定（默认 `<repo>/.data`；挂件独立双击运行时 `%APPDATA%\Vibe-TaskDeck`）。
- 建表 DDL 逐字对齐上游 `database.mjs #migrate()`，全部 `IF NOT EXISTS` 幂等——三方（挂件 Rust / taskctl Node / 上游 server）同库互操作。
- 表：`tasks` / `projects` / `comments` / `activities` / `task_relations` / `attachments` + 索引；`projects.labels` 为 JSON 列（标签库）。
- 并发：双端以 WAL + `busy_timeout=5000` 打开，可并发读写。
- 删除边界：仅**已归档**任务可删除（`TASK_NOT_ARCHIVED`）；删除时 unlink 磁盘附件。
- 附件：DB 存元数据，内容存磁盘 `<dataDir>/attachments/<uuid>`；id 先过 UUID 正则再拼路径（构造性免疫路径穿越）。
- `update_task`：字段白名单 + `version` 乐观并发 + labels 与项目标签库合并去重 + status 变化置 `sortOrder=min-1000` + 活动流只记实际变化字段。

## 命令层（Tauri invoke）

`commands.rs` 注册了 19 个 invoke 命令（另有 `clamp_to_monitor` 等内部辅助函数）。新增命令必须同时改两处（Tauri command 双注册），否则 ACL 静默拒绝：

1. `main.rs` 的 `generate_handler![…]`
2. `capabilities/default.json` 的 allow 列表

分组：读（`load_data` / `issue_detail` / `read_attachment`）、任务写（`create_task` / `update_task` / `move_task` / `archive_task` / `restore_task` / `delete_task`）、评论（`add_comment` 等）、标签库（`add_label` / `delete_label`）、关联（`add_relation` / `remove_relation`，one-parent 唯一索引）、附件（`upload_attachment` ≤10MB base64 等）、窗口（`open_full_board` / `set_window_size` / `close_window`）。

## 双窗口与 WebView2 注意事项

踩坑记录（详见会话记忆，改窗口代码前必读）：

- **同进程多 WebView2 环境的 `additional_browser_arguments` 必须完全一致**（含 CDP 端口），否则第二窗口 build 成功但**静默不显示**。
- **主线程闭包内调用窗口方法（show/set_focus/unminimize）会自锁消息泵**——窗口操作移到闭包外执行。
- **wry 默认注册 OLE drop target，吞掉 HTML5 DnD**——开窗时设 `disable_drag_drop_handler()`，否则看板拖拽失效。
- 双屏防探出：`set_window_size` 后必须 clamp；拖拽中**零干预**（实时 clamp 会把窗口顶死无法换屏），松手（左键检测 + 300ms 防抖）才收边；跨屏计算用物理坐标 + 重叠面积最大屏。
- 挂件无框透明窗口：Win10 无系统圆角，圆角靠透明窗口 + 页面 border-radius 裁剪。

## 事件同步机制

写命令经 Tauri `emit` 广播到两窗口（事件名禁点号）：`task-updated` / `task-archived` / `task-restored` / `task-deleted` / `labels-updated` / `relation-updated`。两窗口收到后全量 `load_data` 刷新（单项目量级足够），另有约 5 秒轮询兜底感知外部（taskctl）写入。

## 状态通知（系统 toast）

外部（taskctl / AI）把任务流转进 **in_review / blocked** 时弹 Windows toast，点击 → 唤起挂件 + 展开面板直达该任务详情（`notification-click{taskId}` → App.tsx 路由 → `openDetail`；详情已展开时 `TaskDetail` 按 `detailId` 依赖直切，不重挂载）。

- **diff 决策**（`commands.rs::notify_status_changes`，cargo 单测钉住）：挂件每次 `load_data` 与上次快照（`NotifyBaseline`，内存态）比对；首次只建基线；基线后新增任务直落同样算「新进入」；归档不弹。只捕捉外部写入——挂件自身 UI 操作走事件即时刷新。
- **WinRT 直连**：`tauri-winrt-notification`（插件层未暴露 Activated 回调）；`show()` 内含 10ms sleep，跑在命令线程。
- **AUMID 自注册**（`main.rs::ensure_aumid_registered`）：启动时 `reg add HKCU\...\AppUserModelId\<identifier>`。**坑**：AUMID 未注册时 `Show()` 不报错但系统静默丢弃整条 toast——免安装直跑 exe 必然踩中；另 Windows 全局 `ToastEnabled=0` 也会整层拦截。

## 筛选语义

筛选栏收纳为「触发器 + 下拉面板」（对齐上游 TaskFilterMenu / Linear 范式）：

- **看板视图**：状态筛选 = **只显示所选列**（列即状态，未选列整列隐藏）；优先级/标签/搜索词为卡片级 AND 过滤。
- **列表视图**：四维（状态/优先级/标签/搜索词）全量生效，对齐上游 `filteredTasks` 语义。
- URL 同步：`?status=&priority=&label=&content=`（replaceState，刷新可还原）；已激活条件以可单独删除的胶囊显示。

## 设计令牌与主题

三层结构（`tokens.css`）：PRIMITIVE（色板）→ SEMANTIC（`.dark` / `.light` 语义映射）→ 组件只引用 SEMANTIC。换风格只改 tokens.css，组件零硬编码颜色。

主题解析顺序：localStorage > `prefers-color-scheme` > 暗色；`html` 内联 THEME-BOOT 脚本防闪烁。

## 动效体系

- 令牌：`--duration-fast:120ms` / `--duration-base:180ms` / `--ease-out:cubic-bezier(.16,1,.3,1)`
- 原则：反馈 120ms / 常规状态 180ms / 入场 180ms / 退出 120ms（退出快于入场）；颜色族过渡不写 `transition:all`
- `prefers-reduced-motion` 全套登记（位移类豁免、opacity 保留）
- 菜单统一 `fb-menu-in` 150ms；进行中状态点呼吸 2.4s（offline 告警 1.4s 急促与之区分）

## 测试体系

```powershell
cd widget; npm run build              # 前置：产物新鲜
cd tests; node run-all.mjs            # mock 层 12 套件（无头 Chrome + mock __TAURI_INTERNALS__）
# 真实层（连运行中的挂件）：挂件以 WEBVIEW2_CDP_PORT=8490 启动后
$env:WIDGET_CDP_PORT=8490; node run-all.mjs
cd src-tauri; cargo test              # Rust 单测（db.rs 随函数走）
```

- mock 层：注入 `__TAURI_INTERNALS__` 内存版 invoke（含 version 计数器模拟冲突）；**契约是 DOM id/类名**（`#viewToggle` / `.fb-card` 等），改前端需同步断言。详情就地编辑契约集中在 `p2-detail-verify.mjs`（16 断言：`#dTitle/#dTitleInput`、`#dDesc/#dDescEdit`、`#dPri/#dPriMenu[data-p]`、`#dDue/#dDueInput/#dDueClear`，非受控输入——e2e 直接设 value 后派发 keydown/change）。
- 真实层：CDP 连真实挂件，验证 SQLite 往返与双窗口事件同步；fullboard target 按 URL 含 `fullboard.html` 匹配。
- 历史教训：mock 数据字段与真实 `load_data` 曾不一致掩盖缺字段问题——改 mock 数据时逐一核对真实返回。

## 环境变量

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `VIBE_TASKDECK_DATA_DIR` | 任务数据库目录 | `<repo>/.data`（挂件独立运行时 `%APPDATA%\Vibe-TaskDeck`） |
| `VIBE_TASKDECK_RUNTIME_DIR` | 挂件 PID/状态运行目录 | `<repo>/.tmpfiles/Vibe-TaskDeck` |
| `VIBE_TASKDECK_WIDGET_DIR` / `VIBE_TASKDECK_WIDGET_EXE` | 挂件源码目录 / 可执行文件路径 | `widget/` 自动探测 |
| `WEBVIEW2_CDP_PORT` | WebView2 CDP 调试端口（端到端测试用） | 不设 |

## 已知技术债

- ~~`cli/taskctl-local.mjs` 依赖本地 `upstream/`（不入库）的 `TaskboardDatabase`~~ 已清偿（2026-08-26）：数据层自研为 `cli/database.mjs` + `cli/domain.mjs`（node:sqlite，DDL/PRAGMA/乐观锁/活动流语义对齐 `widget/src-tauri/src/db.rs`），克隆即可用；`upstream/` 仅保留本地语义参考用途。
- taskctl 本地模式不支持 cloud / project map / relation / attachment（关联与附件经挂件全版看板操作）。
- 人侧 actor 身份为 db.rs 硬编码 `LOCAL_USER_ACTOR`（单机单用户假设）。未来引入多成员时采用与 `VIBE_TASKDECK_ACTOR_ID/NAME` 对称的 `VIBE_TASKDECK_USER_ID/NAME` env 方案，不要另发明机制。数据模型无迁移负担（行级 `(type,id,name,avatar)` 快照）。重启条件三选一：数据共享通道立项 / 真实单机多用户反馈 / assignee 再分配需求——注意第一条本身是 PRODUCT.md 红线变更，须先修订 PRODUCT.md 再动代码。
