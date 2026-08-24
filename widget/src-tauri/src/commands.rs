/* ============================================================
 * commands —— Tauri command 层：桥接前端 invoke 与 db 数据层
 *
 * 窗口控制命令（set_window_size / close_window）沿用原实现；
 * 数据命令（load_data / create_task / move_task）持锁调用 db 层，
 * 写操作成功后 emit 事件驱动前端即时刷新。
 * ============================================================ */

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::{self, Db};

/// 拉取挂件所需的全部数据（任务 + 项目）
#[tauri::command]
pub fn load_data(db: State<Db>) -> Result<serde_json::Value, db::CommandError> {
    let conn = db
        .0
        .lock()
        .map_err(|_| db::CommandError { code: "DB_ERROR", message: "数据库连接锁中毒".into() })?;
    Ok(db::load_data(&conn))
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
    let _ = app.emit("task.created", ());
    Ok(task)
}

/// 流转任务（乐观并发：version 过期返回 VERSION_CONFLICT 由前端重试）
#[tauri::command]
pub fn move_task(
    app: AppHandle,
    db: State<Db>,
    id: String,
    version: i64,
    status: String,
) -> Result<serde_json::Value, db::CommandError> {
    let conn = db
        .0
        .lock()
        .map_err(|_| db::CommandError { code: "DB_ERROR", message: "数据库连接锁中毒".into() })?;
    let task = db::move_task(&conn, &id, version, &status)?;
    let _ = app.emit("task.moved", ());
    Ok(task)
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
    let _ = app.emit("task.comment", ());
    Ok(comment)
}

/// L3-全版入口：拉起 server 模式 + 打开第二窗口内嵌看板。
///
/// 进程管理归属：不直接 spawn Node，而是调用 skill/taskboard.py start
/// （幂等复用、PID 记录到 state.json、可达性等待都由 Python wrapper 负责，
/// stop/clean 语义保持单一属主）。本命令只做：解析仓库根 → 调 wrapper →
/// 成功后开 fullboard 窗口。
#[tauri::command]
pub async fn open_full_board(app: AppHandle) -> Result<serde_json::Value, db::CommandError> {
    // 仓库根：exe 位于 <repo>/widget/src-tauri/target/<triple>/<profile>/，上溯 4 级
    let repo_root = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::new).map(|p| p.to_path_buf()))
        .and_then(|p| p.parent().map(PathBuf::from))
        .and_then(|p| p.parent().map(PathBuf::from))
        .and_then(|p| p.parent().map(PathBuf::from))
        .ok_or_else(|| db::CommandError {
            code: "FULLBOARD_UNAVAILABLE",
            message: "无法定位仓库根目录".into(),
        })?;
    let script = repo_root.join("skill").join("taskboard.py");
    let source = repo_root.join("upstream");
    if !script.is_file() || !source.is_dir() {
        return Err(db::CommandError {
            code: "FULLBOARD_UNAVAILABLE",
            message: "未找到 skill/taskboard.py 或 upstream/ 源码目录（全版看板需要 upstream + Node 22.5+）".into(),
        });
    }

    // 调 wrapper（阻塞等待就绪，默认超时 20s；--json 便于解析 url）
    // 用 tauri::async_runtime 的进程执行（Tauri 内置 tokio，无需额外依赖）
    let output = tauri::async_runtime::spawn_blocking(move || {
        std::process::Command::new("python")
            .arg(&script)
            .arg("--source")
            .arg(&source)
            .arg("--json")
            .arg("start")
            .output()
    })
    .await
    .map_err(|e| db::CommandError {
        code: "FULLBOARD_ERROR",
        message: format!("内部任务失败：{e}"),
    })?
    .map_err(|e| db::CommandError {
        code: "FULLBOARD_UNAVAILABLE",
        message: format!("调用 taskboard.py 失败：{e}"),
    })?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    // stdout 可能混入非 JSON 行（如 node 实验警告），先试整体解析，失败则取最后一个 { 之后的部分
    let payload: serde_json::Value = serde_json::from_str(stdout.trim())
        .or_else(|_| {
            let start = stdout.rfind('{');
            match start {
                Some(s) => serde_json::from_str(stdout[s..].trim_end()),
                None => Err(serde_json::from_str::<serde_json::Value>("").unwrap_err()),
            }
        })
        .map_err(|_| db::CommandError {
            code: "FULLBOARD_ERROR",
            message: format!(
                "无法解析 taskboard.py 输出：{}",
                stdout.trim().chars().take(200).collect::<String>()
            ),
        })?;
    if payload.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        let error = payload.get("error").and_then(|v| v.as_str()).unwrap_or("未知错误");
        return Err(db::CommandError {
            code: "FULLBOARD_UNAVAILABLE",
            message: format!("server 启动失败：{error}"),
        });
    }
    let url = payload
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| db::CommandError {
            code: "FULLBOARD_ERROR",
            message: "taskboard.py 未返回 url".into(),
        })?
        .to_string();

    // 第二窗口：有装饰、可调整大小（全版看板需要大窗口交互）
    // 已开时聚焦即可（WebviewWindowBuilder 同 label 会冲突）
    if let Some(existing) = app.get_webview_window("fullboard") {
        let _ = existing.set_focus();
    } else {
        tauri::WebviewWindowBuilder::new(
            &app,
            "fullboard",
            tauri::WebviewUrl::External(url.parse().map_err(|_| db::CommandError {
                code: "FULLBOARD_ERROR",
                message: format!("非法 URL：{url}"),
            })?),
        )
        .title("dashi-taskboard 全版看板")
        .inner_size(1280.0, 800.0)
        .center()
        .min_inner_size(720.0, 480.0)
        .build()
        .map_err(|e| db::CommandError {
            code: "FULLBOARD_ERROR",
            message: format!("创建全版窗口失败：{e}"),
        })?;
    }
    Ok(serde_json::json!({ "ok": true, "url": url }))
}

/// 调整挂件窗口尺寸（供前端两级切换调用）
#[tauri::command]
pub fn set_window_size(app: AppHandle, w: f64, h: f64) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_size(tauri::LogicalSize::new(w, h));
    }
}

/// 退出挂件（关闭窗口即退出应用）
#[tauri::command]
pub fn close_window(app: AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.close();
    }
}
