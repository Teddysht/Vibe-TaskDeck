# widget 验证套件

挂件前端的行为回归测试。全部基于真实浏览器（无头 Chrome + CDP WebSocket）
驱动 DOM 断言，非纯静态检查。

## 快速开始

```bash
node widget/tests/run-all.mjs
```

自动构建 `widget/dist/mini.html` 后顺序执行 mock 层六套脚本，汇总结果。
产物（JSON 结果 / 截图 / 临时 profile）落在 `widget/tests/.out/`（已 gitignore）。

## 套件说明

### mock 层（默认）

| 脚本 | 覆盖 |
|---|---|
| `p1-verify.mjs` | 筛选「全部」复位（单向门）、版本冲突 toast |
| `p2-detail-verify.mjs` | 详情页流转动作条、冲突重试、协议收敛回归 |
| `p2-1-verify.mjs` | viewToggle 图标随布局切换、closeBtn 防误触 |
| `p2-3-verify.mjs` | --text-weak 对比度 ≥4.5:1、Tab/Enter 键盘可达 |
| `sharp-verify.mjs` | agent 徽标三视图、胶囊点击展开、XSS 转义防注入 |
| `p3-verify.mjs` | 指示点 scaleX 视觉等价、--font-xs 10.5px |

mock 层通过 `Page.addScriptToEvaluateOnNewDocument` 在页面加载前注入
mock `window.__TAURI__`（含可控的 load_data / move_task 行为），走真实
DOM 渲染管线。

**注意 mock 盲区**：mock 数据自带后端字段（如 `creatorType`），可能掩盖
后端缺字段问题（曾实际发生，见 `list_tasks_includes_creator_type` 回归
测试）——发布前建议追加真实层。

### 真实层（可选）

```bash
# 终端 1：以 CDP 端口启动挂件（debug 构建）
cd widget/src-tauri
WEBVIEW2_CDP_PORT=8490 cargo run --no-default-features

# 终端 2：追加真实层套件
WIDGET_CDP_PORT=8490 node widget/tests/run-all.mjs
```

| 脚本 | 覆盖 |
|---|---|
| `e2e-real-verify.mjs` | 真实 SQLite 读写、新建/流转/筛选/详情全链路 |
| `agent-real-verify.mjs` | taskctl 带 CODEX_THREAD_ID 创建 agent 任务 → 挂件轮询发现 → 四层 AI 徽标（自包含，测完清理） |

真实层连接运行中的挂件 WebView2（真实 Rust command + SQLite，零 mock）。
Windows 受限环境下 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 环境变量无法
透传到 WebView2 子进程，故由 `main.rs` 在 debug 构建下读取
`WEBVIEW2_CDP_PORT` 显式开端口（release 零影响）。

## 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `CHROME_PATH` | 无头 Chrome 路径 | `C:/Program Files/Google/Chrome/Application/chrome.exe` |
| `WIDGET_CDP_PORT` | 运行中挂件的 CDP 端口；设置后追加真实层 | （未设则跳过真实层） |

## 已知事项

- 各 mock 脚本使用互异的本地端口（8473-8478 / 8483-8487 / 8495），若有
  端口冲突请先清理残留无头 Chrome 进程（按 user-data-dir 特征精确匹配）。
- mock 脚本以 CDP `Browser.close` 优雅退出，避免渲染进程孤儿锁 profile。
