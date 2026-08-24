/* ============================================================
 * commands —— Tauri command 层：桥接前端 invoke 与 db 数据层
 *
 * 窗口控制命令（set_window_size / close_window）沿用原实现；
 * 数据命令（load_data / create_task / move_task）持锁调用 db 层，
 * 写操作成功后 emit 事件驱动前端即时刷新。
 * ============================================================ */

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
    // 仓库根：从 exe 所在目录逐级向上查找含 skill/taskboard.py 与 upstream/ 的目录
    // （exe 嵌套层级可能因 target/profile 变化，不硬编码层级数）
    let repo_root = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .and_then(|start| {
            let mut cur = Some(start);
            while let Some(dir) = cur {
                if dir.join("skill").join("taskboard.py").is_file()
                    && dir.join("upstream").is_dir()
                {
                    return Some(dir);
                }
                cur = dir.parent().map(|p| p.to_path_buf());
            }
            None
        })
        .ok_or_else(|| db::CommandError {
            code: "FULLBOARD_UNAVAILABLE",
            message: "未找到仓库根目录（需含 skill/taskboard.py 与 upstream/；全版看板依赖 upstream 源码 + Node 22.5+）".into(),
        })?;
    let script = repo_root.join("skill").join("taskboard.py");
    let source = repo_root.join("upstream");

    // 调 wrapper（阻塞等待就绪，默认超时 20s；--json 便于解析 url）
    // 用 tauri::async_runtime 的进程执行（Tauri 内置 tokio，无需额外依赖）。
    // CREATE_NO_WINDOW：挂件是 GUI 程序无控制台，python 是 console 程序，
    // 不加此标志 Windows 会弹出「Python」控制台黑窗（node 孙进程还会继承持有）。
    let output = tauri::async_runtime::spawn_blocking(move || {
        let mut command = std::process::Command::new("python");
        command
            .arg(&script)
            .arg("--source")
            .arg(&source)
            .arg("--json")
            .arg("start");
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        command.output()
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
        // ?host=codex 激活上游 embedded 模式：隐藏侧栏（单列全宽）、
        // 拖拽区、紧凑样式——为 iframe 宿主设计的整套适配，Tauri 第二窗口
        // 同样适用。上游只读，不改其源码，仅通过 URL 参数选择模式。
        let embedded_url = if url.contains('?') {
            format!("{url}&host=codex")
        } else {
            format!("{url}?host=codex")
        };
        // async command 跑在 tokio worker 线程；Windows 上窗口创建必须在
        // 主线程（否则 build 静默不产窗）。通过 channel 取回主线程结果。
        let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
        let app_for_thread = app.clone();
        app.run_on_main_thread(move || {
            let result = tauri::WebviewWindowBuilder::new(
                &app_for_thread,
                "fullboard",
                tauri::WebviewUrl::External(embedded_url.parse().unwrap()),
            )
            .title("dashi-taskboard 全版看板")
            .inner_size(1280.0, 800.0)
            .center()
            // 独立 user-data-dir：第二个 WebView 复用主窗口数据目录时会在
            // 部分 WebView2 版本上静默失败（build 返回 Ok 但窗口不出现，151 实测）
            .data_directory(
                std::env::var("LOCALAPPDATA")
                    .map(|d| std::path::PathBuf::from(d).join("com.dashi.taskboard-widget").join("fullboard-data"))
                    .unwrap_or_default(),
            )
            // embedded 单列布局无 840px 断点保护，窗口过窄时看板列会挤压；
            // 下限收到 embedded 可用宽度（侧栏已隐藏，主区即全部）
            .min_inner_size(900.0, 520.0)
            .build()
            .map(|_| ())
            .map_err(|e| format!("创建全版窗口失败：{e}"));
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
