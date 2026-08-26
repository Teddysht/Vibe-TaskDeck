/* ============================================================
 * commands —— Tauri command 层：桥接前端 invoke 与 db 数据层
 *
 * 窗口控制命令（set_window_size / close_window）沿用原实现；
 * 数据命令（load_data / create_task / move_task）持锁调用 db 层，
 * 写操作成功后 emit 事件驱动前端即时刷新。
 * ============================================================ */

use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::{self, Db};

/// 把窗口 clamp 回「与其重叠面积最大的显示器」的工作区内（物理像素直算，
/// 规避跨屏混合 DPI 下逻辑坐标换算漂移）。仅越界时才 set_position——界内
/// 调用方安全。
///
/// 判定用重叠最大而非 current_monitor：窗口跨界（拖拽松手时探出一角）时
/// 贴着重叠大的屏收边，移动距离最小；current_monitor 的归属判定会把窗口
/// 整体吸入另一屏，跳变突兀。
///
/// 双屏探出的两个来源都靠它兜底：
///   1. 尺寸切换（胶囊 280 → 大面板 360 宽）时 set_size 不改位置，
///      右缘停泊的挂件展开即探出邻屏；
///   2. app-region 拖拽越过屏幕边缘，Windows 不阻止窗口部分越界。
pub(crate) fn clamp_to_monitor(win: &tauri::WebviewWindow) {
    let Ok(pos) = win.outer_position() else { return };
    let Ok(size) = win.outer_size() else { return };
    let (x, y) = (pos.x as i64, pos.y as i64);
    let (w, h) = (size.width as i64, size.height as i64);
    let monitors = win.available_monitors().unwrap_or_default();
    let best = monitors.iter().max_by_key(|m| {
        let mp = m.position();
        let ms = m.size();
        let ox = (x + w).min(mp.x as i64 + ms.width as i64) - x.max(mp.x as i64);
        let oy = (y + h).min(mp.y as i64 + ms.height as i64) - y.max(mp.y as i64);
        ox.max(0) * oy.max(0)
    });
    let Some(monitor) = best else { return };
    let area = monitor.work_area();
    let (ax, ay, aw, ah) = (
        area.position.x as i64,
        area.position.y as i64,
        area.size.width as i64,
        area.size.height as i64,
    );
    // 窗口大于工作区（理论上不发生：挂件远小于屏）时对齐左上，避免反向溢出
    let max_x = ax + (aw - w).max(0);
    let max_y = ay + (ah - h).max(0);
    let new_x = x.clamp(ax, max_x);
    let new_y = y.clamp(ay, max_y);
    if new_x != x || new_y != y {
        let _ = win.set_position(tauri::PhysicalPosition::new(new_x as i32, new_y as i32));
    }
}

/// 拉取挂件所需的全部数据（任务 + 项目）
#[tauri::command]
pub fn load_data(app: AppHandle, db: State<Db>) -> Result<serde_json::Value, db::CommandError> {
    let conn = db
        .0
        .lock()
        .map_err(|_| db::CommandError { code: "DB_ERROR", message: "数据库连接锁中毒".into() })?;
    let data = db::load_data(&conn);
    // 状态通知：diff 上次快照，新进入 in_review/blocked 的任务弹系统通知
    // （这两个状态需要人介入；其余状态不弹）。首次 load 只建基线。
    notify_status_changes(&app, &data);
    Ok(data)
}

/// 系统通知 diff（见 main.rs NotifyBaseline 注释）。
/// 只在「上次不是该状态、这次是」时弹——同任务多次轮询同状态不重复打扰。
fn notify_status_changes(app: &AppHandle, data: &serde_json::Value) {
    use std::collections::HashMap;
    use tauri_plugin_notification::NotificationExt;

    let Some(tasks) = data.get("tasks").and_then(|t| t.as_array()) else { return };
    let mut current: HashMap<String, (String, String)> = HashMap::new(); // id → (status, title)
    for task in tasks {
        if let (Some(id), Some(status), Some(title)) = (
            task.get("id").and_then(|v| v.as_str()),
            task.get("status").and_then(|v| v.as_str()),
            task.get("title").and_then(|v| v.as_str()),
        ) {
            current.insert(id.to_string(), (status.to_string(), title.to_string()));
        }
    }

    let baseline = app.state::<crate::NotifyBaseline>();
    let mut guard = baseline.0.lock().unwrap();
    let Some(prev) = guard.as_ref() else {
        // 首次：建基线不弹
        *guard = Some(current.into_iter().map(|(k, (s, _))| (k, s)).collect());
        return;
    };

    for (id, (status, title)) in &current {
        let notify = match status.as_str() {
            "in_review" => Some(("任务待评审", "待你验收")),
            "blocked" => Some(("任务被阻塞", "需要你介入")),
            _ => None,
        };
        // 上次不存在或状态不同，且本次是需要人介入的状态 → 弹
        if let Some((head, action)) = notify {
            if prev.get(id).map(|old| old != status).unwrap_or(false) {
                let _ = app
                    .notification()
                    .builder()
                    .title(head)
                    .body(format!("{title} — {action}"))
                    .show();
            }
        }
    }
    *guard = Some(current.into_iter().map(|(k, (s, _))| (k, s)).collect());
}

/// 新建任务（挂件表单）
#[tauri::command]
pub fn create_task(
    app: AppHandle,
    db: State<Db>,
    title: String,
    status: Option<String>,
    priority: Option<String>,
    due_date: Option<String>,
) -> Result<serde_json::Value, db::CommandError> {
    let conn = db
        .0
        .lock()
        .map_err(|_| db::CommandError { code: "DB_ERROR", message: "数据库连接锁中毒".into() })?;
    let task = db::create_task(
        &conn,
        title.trim(),
        status.as_deref().unwrap_or("backlog"),
        priority.as_deref().unwrap_or("none"),
        due_date.as_deref().filter(|s| !s.is_empty()),
    )?;
    let _ = app.emit("task-created", ());
    Ok(task)
}

/// 流转任务（乐观并发：version 过期返回 VERSION_CONFLICT 由前端重试）
/// sortOrder：全版看板拖拽落点排序（前/后卡的中值）；缺省走上游惯例
#[tauri::command]
pub fn move_task(
    app: AppHandle,
    db: State<Db>,
    id: String,
    version: i64,
    status: String,
    sort_order: Option<f64>,
) -> Result<serde_json::Value, db::CommandError> {
    let conn = db
        .0
        .lock()
        .map_err(|_| db::CommandError { code: "DB_ERROR", message: "数据库连接锁中毒".into() })?;
    let task = db::move_task(&conn, &id, version, &status, sort_order)?;
    let _ = app.emit("task-moved", ());
    Ok(task)
}

/// 更新任务属性（全版看板详情编辑底座；活动流 diff 由 db 层计算）
#[tauri::command]
pub fn update_task(
    app: AppHandle,
    db: State<Db>,
    id: String,
    version: i64,
    changes: serde_json::Value,
) -> Result<serde_json::Value, db::CommandError> {
    let conn = db
        .0
        .lock()
        .map_err(|_| db::CommandError { code: "DB_ERROR", message: "数据库连接锁中毒".into() })?;
    let task = db::update_task(&conn, &id, version, &changes)?;
    let _ = app.emit("task-updated", serde_json::json!({ "taskId": id }));
    Ok(task)
}

/// 归档任务（全版看板 OtherTasksPanel）
#[tauri::command]
pub fn archive_task(
    app: AppHandle,
    db: State<Db>,
    id: String,
    version: i64,
) -> Result<serde_json::Value, db::CommandError> {
    let conn = db
        .0
        .lock()
        .map_err(|_| db::CommandError { code: "DB_ERROR", message: "数据库连接锁中毒".into() })?;
    let task = db::archive_task(&conn, &id, version)?;
    let _ = app.emit("task-archived", serde_json::json!({ "taskId": id }));
    Ok(task)
}

/// 恢复归档任务
#[tauri::command]
pub fn restore_task(
    app: AppHandle,
    db: State<Db>,
    id: String,
    version: i64,
) -> Result<serde_json::Value, db::CommandError> {
    let conn = db
        .0
        .lock()
        .map_err(|_| db::CommandError { code: "DB_ERROR", message: "数据库连接锁中毒".into() })?;
    let task = db::restore_task(&conn, &id, version)?;
    let _ = app.emit("task-restored", serde_json::json!({ "taskId": id }));
    Ok(task)
}

/// 删除已归档任务（级联评论/活动/关联/附件；磁盘附件由 db 层清理）
#[tauri::command]
pub fn delete_task(
    app: AppHandle,
    db: State<Db>,
    id: String,
    version: i64,
) -> Result<serde_json::Value, db::CommandError> {
    let conn = db
        .0
        .lock()
        .map_err(|_| db::CommandError { code: "DB_ERROR", message: "数据库连接锁中毒".into() })?;
    let result = db::delete_task(&conn, &id, version)?;
    let _ = app.emit("task-deleted", serde_json::json!({ "taskId": id }));
    Ok(result)
}

/// 标签库新增（projects.labels JSON）
#[tauri::command]
pub fn add_label(
    app: AppHandle,
    db: State<Db>,
    project_id: String,
    label: String,
) -> Result<serde_json::Value, db::CommandError> {
    let conn = db
        .0
        .lock()
        .map_err(|_| db::CommandError { code: "DB_ERROR", message: "数据库连接锁中毒".into() })?;
    let result = db::add_project_label(&conn, &project_id, &label)?;
    let _ = app.emit("labels-updated", serde_json::json!({ "projectId": project_id }));
    Ok(result)
}

/// 标签库删除（并从该标签所属任务的 labels 移除）
#[tauri::command]
pub fn delete_label(
    app: AppHandle,
    db: State<Db>,
    project_id: String,
    label: String,
) -> Result<serde_json::Value, db::CommandError> {
    let conn = db
        .0
        .lock()
        .map_err(|_| db::CommandError { code: "DB_ERROR", message: "数据库连接锁中毒".into() })?;
    let result = db::delete_project_label(&conn, &project_id, &label)?;
    let _ = app.emit("labels-updated", serde_json::json!({ "projectId": project_id }));
    Ok(result)
}

/// 添加任务关联（type: parent/blocks/blocked_by/related）
#[tauri::command]
pub fn add_relation(
    app: AppHandle,
    db: State<Db>,
    id: String,
    version: i64,
    relation_type: String,
    related_task_id: String,
) -> Result<serde_json::Value, db::CommandError> {
    let conn = db
        .0
        .lock()
        .map_err(|_| db::CommandError { code: "DB_ERROR", message: "数据库连接锁中毒".into() })?;
    let result = db::add_relation(&conn, &id, version, &relation_type, &related_task_id)?;
    let _ = app.emit("relation-updated", serde_json::json!({ "taskId": id }));
    Ok(result)
}

/// 移除任务关联
#[tauri::command]
pub fn remove_relation(
    app: AppHandle,
    db: State<Db>,
    id: String,
    version: i64,
    relation_type: String,
    related_task_id: String,
) -> Result<serde_json::Value, db::CommandError> {
    let conn = db
        .0
        .lock()
        .map_err(|_| db::CommandError { code: "DB_ERROR", message: "数据库连接锁中毒".into() })?;
    let result = db::remove_relation(&conn, &id, version, &relation_type, &related_task_id)?;
    let _ = app.emit("relation-updated", serde_json::json!({ "taskId": id }));
    Ok(result)
}

/// 上传附件（base64 内容；≤10MB；磁盘 UUID 文件名）
#[tauri::command]
pub fn upload_attachment(
    app: AppHandle,
    db: State<Db>,
    task_id: String,
    comment_id: Option<String>,
    filename: String,
    content_type: String,
    base64_data: String,
) -> Result<serde_json::Value, db::CommandError> {
    let conn = db
        .0
        .lock()
        .map_err(|_| db::CommandError { code: "DB_ERROR", message: "数据库连接锁中毒".into() })?;
    let result = db::upload_attachment(&conn, &task_id, comment_id.as_deref(), &filename, &content_type, &base64_data)?;
    let _ = app.emit("task-updated", serde_json::json!({ "taskId": task_id }));
    Ok(result)
}

/// 读取附件内容（base64 返回）
#[tauri::command]
pub fn read_attachment(
    db: State<Db>,
    id: String,
) -> Result<serde_json::Value, db::CommandError> {
    let conn = db
        .0
        .lock()
        .map_err(|_| db::CommandError { code: "DB_ERROR", message: "数据库连接锁中毒".into() })?;
    db::read_attachment(&conn, &id)
}

/// 删除附件（DB 行 + 磁盘文件）
#[tauri::command]
pub fn delete_attachment(
    db: State<Db>,
    id: String,
) -> Result<serde_json::Value, db::CommandError> {
    let conn = db
        .0
        .lock()
        .map_err(|_| db::CommandError { code: "DB_ERROR", message: "数据库连接锁中毒".into() })?;
    db::delete_attachment(&conn, &id)
}

/// 任务详情（L3-本机：task 全字段 + 评论 + 活动流一次返回）
#[tauri::command]
pub fn issue_detail(
    db: State<Db>,
    id: String,
) -> Result<serde_json::Value, db::CommandError> {
    let conn = db
        .0
        .lock()
        .map_err(|_| db::CommandError { code: "DB_ERROR", message: "数据库连接锁中毒".into() })?;
    db::issue_detail(&conn, &id)
}

/// 发表评论（归属挂件会话；成功后 emit 事件驱动前端刷新详情与列表）
#[tauri::command]
pub fn add_comment(
    app: AppHandle,
    db: State<Db>,
    task_id: String,
    body: String,
) -> Result<serde_json::Value, db::CommandError> {
    let conn = db
        .0
        .lock()
        .map_err(|_| db::CommandError { code: "DB_ERROR", message: "数据库连接锁中毒".into() })?;
    let comment = db::add_comment(&conn, &task_id, &body)?;
    let _ = app.emit("task-comment", ());
    Ok(comment)
}

/// 全版看板入口：打开（或聚焦）本地页面第二窗口。
///
/// 纯客户端架构：全版看板与挂件同栈（dist/fullboard.html，经 Vite 双通道
/// 构建内嵌），直接 invoke 同一批 Rust command 读写 SQLite——不再拉起
/// Node server（旧 taskboard.py/upstream External-URL 链路已整体移除）。
#[tauri::command]
pub async fn open_full_board(app: AppHandle) -> Result<serde_json::Value, db::CommandError> {
    // 已开时聚焦即可（WebviewWindowBuilder 同 label 会冲突）
    if let Some(existing) = app.get_webview_window("fullboard") {
        let _ = existing.set_focus();
        return Ok(serde_json::json!({ "ok": true }));
    }
    // async command 跑在 tokio worker 线程；Windows 上窗口创建必须在
    // 主线程（否则 build 静默不产窗）。通过 channel 取回主线程结果。
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let app_for_thread = app.clone();
    app.run_on_main_thread(move || {
        let mut builder = tauri::WebviewWindowBuilder::new(
            &app_for_thread,
            "fullboard",
            tauri::WebviewUrl::App("fullboard.html".into()),
        )
        .title("Vibe-TaskDeck 全版看板")
        .inner_size(1280.0, 800.0)
        .center()
        .min_inner_size(900.0, 520.0)
        // 无边框 + 自绘标题栏：与挂件主窗（decorations(false)）同一窗口语言，
        // 避免系统亮色标题栏与暗色 UI 的割裂。标题栏拖拽/最大化/关闭由前端实现。
        // transparent + 页面圆角：与挂件同款方案——Win10 无系统窗口圆角，
        // 圆角靠透明窗口 + .fb-root 的 border-radius 裁剪（最大化时前端
        // 切 .maximized 类归零，避免贴边切出缺口）。
        // shadow(true) + 前端内缩：DWM 阴影提供窗口投影（无框窗口默认丢阴影，
        // 无投影窗口「贴在桌面上」）；DWM 帧实测比窗口矩形内缩 8px 且为直角，
        // 故前端 .fb-root 同步 inset 内缩（CSS --fb-inset），阴影跟窗口矩形
        // 走、页面圆角独立——四角干净且有投影（成熟方案：内缩阴影窗）。
        .decorations(false)
        .shadow(true)
        .transparent(true)
        // HTML5 drag-and-drop 修复：wry 默认给 WebView2 注册 OS 级 OLE
        // drop target（文件拖放用），会吞掉页面内的 HTML5 DnD——看板卡片
        // 拖拽在真机上完全无反应（e2e dispatchEvent 模拟不经过 OLE 层，
        // 故测试全绿掩盖了此问题）。挂件无文件拖放需求，直接关闭。
        .disable_drag_drop_handler();
        // WebView2 限制：同进程内所有环境的 additional_browser_arguments 必须
        // 完全一致。主窗在 WEBVIEW2_CDP_PORT 下设了 --remote-debugging-port，
        // 本窗口必须带同样参数，否则环境创建失败（窗口假死消失，实测）。
        if let Ok(port) = std::env::var("WEBVIEW2_CDP_PORT") {
            if let Ok(port) = port.trim().parse::<u16>() {
                builder = builder.additional_browser_args(&format!("--remote-debugging-port={port}"));
            }
        }
        // 共享主窗口 WebView2 环境（默认，App URL 实测 151 版本无 External URL
        // 时代的「复用数据目录静默不产窗」问题）：两窗口同一 browser process，
        // CDP 调试端口（WEBVIEW2_CDP_PORT）天然覆盖两窗口，事件/IPC 行为一致。
        // 回退开关 TASKBOARD_FULLBOARD_ISOLATED_DATA=1：改用独立 user-data-dir
        // （注意 WebView2 限制——同进程多环境的 additional_browser_arguments
        // 必须一致，主窗带 CDP 参数而本窗口不带时独立环境创建会失败）。
        if std::env::var("TASKBOARD_FULLBOARD_ISOLATED_DATA").ok().as_deref() == Some("1") {
            if let Ok(local) = std::env::var("LOCALAPPDATA") {
                builder = builder.data_directory(
                    std::path::PathBuf::from(local)
                        .join("com.vibe.taskdeck-widget")
                        .join("fullboard-data"),
                );
            }
        }
        // ⚠ 闭包内只做 build：unminimize/show/set_focus 等窗口方法走 wry 的
        // 消息泵（send_user_message 等主线程处理），在主线程闭包内调用等于
        // 自己等自己——webview IPC 从此无响应（实测「failed to receive
        // message from webview」），窗口假死消失。置前操作移到闭包外。
        let result = builder.build().map(|_| ()).map_err(|e| format!("创建全版窗口失败：{e}"));
        let _ = tx.send(result);
    })
    .map_err(|e| db::CommandError {
        code: "FULLBOARD_ERROR",
        message: format!("主线程调度失败：{e}"),
    })?;
    rx.recv()
        .map_err(|_| db::CommandError {
            code: "FULLBOARD_ERROR",
            message: "全版窗口创建结果未返回".into(),
        })?
        .map_err(|e| db::CommandError {
            code: "FULLBOARD_ERROR",
            message: e,
        })?;
    // 置前恢复（async 线程调用，Tauri API 线程安全）：主窗为 always-on-top
    // 工具窗时，第二窗口创建后可能落在最小化位（-32000），显式恢复确保可见。
    if let Some(win) = app.get_webview_window("fullboard") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
    Ok(serde_json::json!({ "ok": true }))
}

/// 调整挂件窗口尺寸（供前端两级切换调用）。
/// 尺寸变化后 clamp 位置：胶囊(280)→大面板(360) 变宽时右缘停泊的挂件
/// 会探出屏幕边缘（邻屏时跨屏），clamp 保持完整落在当前显示器内。
#[tauri::command]
pub fn set_window_size(app: AppHandle, w: f64, h: f64) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_size(tauri::LogicalSize::new(w, h));
        clamp_to_monitor(&win);
    }
}

/// 关闭挂件窗口（驻留托盘：隐藏主窗，进程不退出；退出走托盘「退出」）
#[tauri::command]
pub fn close_window(app: AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }
}

/* ============ 版本与更新检查 ============ */

/// 当前应用版本（tauri.conf.json 注入的 CARGO_PKG_VERSION）
#[tauri::command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// GitHub Release 信息（check_update 的返回载荷）
#[derive(serde::Serialize)]
pub struct ReleaseInfo {
    pub tag: String,        // "v0.2.1"
    pub name: String,       // release 标题
    pub notes: String,      // 更新说明（markdown 原文，前端截摘要）
    pub url: String,        // release 页面链接
    pub newer: bool,        // 是否比当前版本新
}

/// 语义版本比较（仅数字段，v 前缀忽略；预发布后缀按忽略处理——本项目未用）
fn is_newer_tag(remote: &str, current: &str) -> bool {
    let parse = |s: &str| -> Vec<u64> {
        s.trim_start_matches('v')
            .split('.')
            .map(|p| p.trim().chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse::<u64>().unwrap_or(0))
            .collect()
    };
    let r = parse(remote);
    let c = parse(current);
    for i in 0..r.len().max(c.len()) {
        let a = r.get(i).copied().unwrap_or(0);
        let b = c.get(i).copied().unwrap_or(0);
        if a != b {
            return a > b;
        }
    }
    false
}

/// 检查 GitHub 最新 Release（Teddysht/Vibe-TaskDeck）。
/// 5s 超时；网络失败返回 Err（前端静默），不打扰。
#[tauri::command]
pub async fn check_update() -> Result<ReleaseInfo, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .user_agent("taskdeck-widget")
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get("https://api.github.com/repos/Teddysht/Vibe-TaskDeck/releases/latest")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("github api status {}", resp.status()));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let tag = json["tag_name"].as_str().unwrap_or_default().to_string();
    if tag.is_empty() {
        return Err("release tag missing".into());
    }
    let current = env!("CARGO_PKG_VERSION");
    Ok(ReleaseInfo {
        tag: tag.clone(),
        name: json["name"].as_str().unwrap_or(&tag).to_string(),
        notes: json["body"].as_str().unwrap_or_default().to_string(),
        url: json["html_url"].as_str().unwrap_or_default().to_string(),
        newer: is_newer_tag(&tag, current),
    })
}

/// 打开 Release 页面（系统默认浏览器）
#[tauri::command]
pub async fn open_release_page(url: String) -> Result<(), String> {
    tauri_plugin_opener::open_url(&url, None::<&str>)
        .map_err(|e| e.to_string())
}

/// 主题同步：任一窗切换后广播，其余窗即时跟随（两窗各自 localStorage
/// 持久化一份，经此事件保持一致；启动 THEME-BOOT 读各自存储）。
#[tauri::command]
pub fn broadcast_theme(app: AppHandle, mode: String) {
    let _ = app.emit("theme-changed", mode);
}
