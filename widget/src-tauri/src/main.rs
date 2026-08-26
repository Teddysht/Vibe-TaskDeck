#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod db;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

/// 单实例锁持有的文件句柄（存为 managed state，防止提前 drop 释放锁）
#[allow(dead_code)] // 字段仅用于持有句柄保持独占，从不读取
struct InstanceLock(std::fs::File);

/// 拖拽防抖收边状态：Moved 高频触发只记录时间戳；静止 + 左键松开
/// （= 拖拽结束）后才执行一次 clamp。拖拽过程零干预——跨屏自由拖动。
#[derive(Default)]
struct MoveClamp {
    last_moved: Mutex<Option<Instant>>,
    armed: AtomicBool,
}

/// 状态通知基线：上次 load_data 时的 (task_id → status) 快照。
/// 每次 load_data 自查 diff：新进入 in_review/blocked 的任务弹系统通知
/// （这两个状态需要人介入）；首次 load 只建基线不弹。挂件自身 UI 操作
/// 不经过这里（走事件即时刷新），所以只捕捉外部（taskctl/AI）写入。
#[derive(Default)]
struct NotifyBaseline(Mutex<Option<HashMap<String, String>>>);

/// Windows：鼠标左键是否按住（app-region 拖拽期间为真）。
/// 拖拽中永不 clamp，否则窗口被顶在当前屏边缘拖不过去。
#[cfg(target_os = "windows")]
fn drag_button_down() -> bool {
    const VK_LBUTTON: i32 = 0x01;
    unsafe {
        (windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(VK_LBUTTON) as u16
            & 0x8000)
            != 0
    }
}

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

/// 唤回挂件主窗（托盘左键/菜单「显示挂件」）：显示 + 聚焦。
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::load_data,
            commands::create_task,
            commands::move_task,
            commands::issue_detail,
            commands::add_comment,
            commands::update_task,
            commands::archive_task,
            commands::restore_task,
            commands::delete_task,
            commands::add_label,
            commands::delete_label,
            commands::add_relation,
            commands::remove_relation,
            commands::upload_attachment,
            commands::read_attachment,
            commands::delete_attachment,
            commands::open_full_board,
            commands::set_window_size,
            commands::close_window,
            commands::get_app_version,
            commands::check_update,
            commands::open_release_page,
            commands::broadcast_theme,
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
            app.manage(MoveClamp::default());
            app.manage(NotifyBaseline::default());

            // ---- 系统托盘：常驻入口（左键唤回挂件；右键菜单）----
            let show = MenuItem::with_id(app, "show", "显示挂件", true, None::<&str>)?;
            let board = MenuItem::with_id(app, "board", "打开全版看板", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &board, &quit])?;
            let tray = TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Vibe-TaskDeck")
                .menu(&menu)
                // 左键单击也唤回挂件（Windows 托盘惯例：左键=主操作）
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(&tray.app_handle());
                    }
                })
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "board" => {
                        // 命令层开窗（复用 open_full_board 的窗口构建逻辑）
                        let handle = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = commands::open_full_board(handle).await;
                        });
                    }
                    "quit" => {
                        app.exit(0); // 退出释放单实例锁（文件句柄随进程关闭）
                    }
                    _ => {}
                })
                .build(app)?;
            tray.set_visible(true)?;

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
                .title("Vibe-TaskDeck 挂件")
                .inner_size(280.0, 56.0)
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
            // CDP 调试端口（WEBVIEW2_CDP_PORT，debug/release 均可用）：
            // 供无头端到端验证连接真实挂件；不设时零影响。
            if let Ok(port) = std::env::var("WEBVIEW2_CDP_PORT") {
                if let Ok(port) = port.trim().parse::<u16>() {
                    builder = builder.additional_browser_args(&format!("--remote-debugging-port={port}"));
                }
            }
            builder.build()?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        // 窗口事件两分支（单 match 避免 event 被 move 两次）：
        // 1) 关闭驻留：主窗收到关闭请求（× / close_window 命令）时拦截
        //    prevent_close 改为隐藏——进程常驻托盘（挂件类应用惯例：
        //    「关闭」≠「退出」，退出走托盘菜单「退出」，由 quit 菜单
        //    app.exit(0) 完成并释放单实例锁）。
        // 2) 拖拽收边（防抖 + 左键检测）：拖拽过程零干预（跨屏自由拖动）；
        //    松手后窗口若探出屏幕边缘（Windows 允许部分越界），把窗口收回
        //    与其重叠面积最大的显示器内。Moved 高频触发只记时间戳，静止
        //    300ms 且左键已松开才执行一次 clamp；armed 保证同一时刻仅一条
        //    防抖线程。尺寸切换的同步 clamp 见 commands::set_window_size。
        if let tauri::RunEvent::WindowEvent { label, event: win_event, .. } = event {
            if label != "main" {
                return;
            }
            match win_event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    if let Some(win) = app_handle.get_webview_window("main") {
                        let _ = win.hide();
                    }
                }
                tauri::WindowEvent::Moved(_) => {
                    let state = app_handle.state::<MoveClamp>();
                    *state.last_moved.lock().unwrap() = Some(Instant::now());
                    if !state.armed.swap(true, Ordering::AcqRel) {
                        let app = app_handle.clone();
                        std::thread::spawn(move || {
                            if let Some(win) = app.get_webview_window("main") {
                                let state = app.state::<MoveClamp>();
                                let deadline = Instant::now() + Duration::from_secs(15);
                                loop {
                                    std::thread::sleep(Duration::from_millis(100));
                                    let Some(t) = *state.last_moved.lock().unwrap() else {
                                        break;
                                    };
                                    if Instant::now().duration_since(t) < Duration::from_millis(300) {
                                        continue;
                                    }
                                    // 拖拽进行中（左键按住）：继续等，绝不打断
                                    #[cfg(target_os = "windows")]
                                    {
                                        if drag_button_down() && Instant::now() < deadline {
                                            continue;
                                        }
                                    }
                                    commands::clamp_to_monitor(&win);
                                    break;
                                }
                            }
                            // 无论哪条路径退出都复位，允许下一轮拖拽重新武装
                            if let Some(state) = app.try_state::<MoveClamp>() {
                                state.armed.store(false, Ordering::SeqCst);
                            }
                        });
                    }
                }
                _ => {}
            }
        }
    });
}
