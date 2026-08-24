#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod db;

use std::path::PathBuf;
use tauri::Manager;

/// 单实例锁持有的文件句柄（存为 managed state，防止提前 drop 释放锁）
#[allow(dead_code)] // 字段仅用于持有句柄保持独占，从不读取
struct InstanceLock(std::fs::File);

/// Windows：以独占共享模式打开锁文件；错误码 32（共享冲突）表示已有实例在运行。
#[cfg(target_os = "windows")]
fn acquire_instance_lock(path: &std::path::Path) -> Result<Option<std::fs::File>, std::io::Error> {
    use std::fs::OpenOptions;
    use std::os::windows::fs::OpenOptionsExt;
    match OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .share_mode(0) // 独占
        .open(path)
    {
        Ok(file) => Ok(Some(file)),
        Err(e) if e.raw_os_error() == Some(32) => Ok(None), // ERROR_SHARING_VIOLATION
        Err(e) => Err(e),
    }
}

fn main() {
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::load_data,
            commands::create_task,
            commands::move_task,
            commands::issue_detail,
            commands::add_comment,
            commands::open_full_board,
            commands::set_window_size,
            commands::close_window,
        ])
        .setup(|app| {
            // 单实例锁：已在运行时直接退出，不重复拉起第二个挂件
            #[cfg(target_os = "windows")]
            {
                let lock_path: PathBuf = app.path().app_data_dir()?.join("widget.lock");
                if let Some(dir) = lock_path.parent() {
                    std::fs::create_dir_all(dir)?;
                }
                match acquire_instance_lock(&lock_path)? {
                    Some(file) => {
                        app.manage(InstanceLock(file));
                    }
                    None => {
                        app.handle().exit(0);
                    }
                }
            }

            // 纯客户端数据层：直连 SQLite（与 taskctl-local / server 模式共享同一库）
            let conn = db::open_database()?;
            app.manage(db::Db(std::sync::Mutex::new(conn)));

            // 挂件页面为编译期内嵌资源（frontendDist → widget/dist/mini.html）
            // 默认停靠主屏右上角（胶囊挂件惯例位）：x 留 24px 边距，y 留 16px
            let monitor = app.primary_monitor().ok().flatten();
            let (physical_w, scale) = match &monitor {
                Some(m) => (m.size().width as f64, m.scale_factor()),
                None => (2560.0, 1.0),
            };
            let logical_w = physical_w / scale;
            let pos_x = (logical_w - 280.0 - 24.0).max(0.0);
            let mut builder = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("mini.html".into()))
                .title("dashi-taskboard 挂件")
                .inner_size(280.0, 48.0)
                .position(pos_x, 16.0)
                .always_on_top(true)
                .decorations(false)
                .skip_taskbar(true)
                .resizable(false)
                // 透明窗口：Win10 无系统级窗口圆角，胶囊圆角只能靠
                // 透明窗口 + 页面内 .mini 的 border-radius 裁剪实现。
                // 风险：WebView2 151 透明合成层丢失会导致整窗不显示——
                // 若复现（拉起后窗口不存在/全透明不可见），回退为
                // .transparent(false) + .background_color(#0a0b0d) + body 不透明底色。
                .transparent(true)
                .shadow(false);
            // debug 构建：开 CDP 调试端口，供无头端到端验证连接（WEBVIEW2_CDP_PORT 可覆盖）
            #[cfg(debug_assertions)]
            {
                if let Ok(port) = std::env::var("WEBVIEW2_CDP_PORT") {
                    if let Ok(port) = port.trim().parse::<u16>() {
                        builder = builder.additional_browser_args(&format!("--remote-debugging-port={port}"));
                    }
                }
            }
            builder.build()?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app_handle, _event| {});
}
