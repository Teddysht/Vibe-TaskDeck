use std::path::PathBuf;

// 前端已迁移 Vite（widget/package.json，产物 dist/mini.html）：
//  - 日常构建走 tauri CLI 的 beforeBuildCommand / beforeDevCommand；
//  - cargo 直构（tests/README 真实层流程）只做产物存在性检查——
//    绝不静默嵌入缺失/陈旧产物（旧 mtime 检测随 build-widget.mjs 废弃）。
fn main() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let widget_root = manifest_dir
        .parent()
        .expect("src-tauri 的上级应为 widget/")
        .to_path_buf();

    let dist = widget_root.join("dist").join("mini.html");
    if !dist.exists() {
        panic!(
            "widget/dist/mini.html 缺失：请先在 widget/ 目录执行 `npm install && npm run build`"
        );
    }
    println!("cargo:rerun-if-changed={}", dist.display());

    // 显式声明自定义 command，为其自动生成 allow-$command 权限，
    // 使内嵌页面能通过 ACL 调用它们（纯客户端：load/create/move + 窗口控制）。
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new()
                .commands(&["load_data", "create_task", "move_task", "issue_detail", "add_comment", "update_task", "archive_task", "restore_task", "delete_task", "add_label", "delete_label", "add_relation", "remove_relation", "upload_attachment", "read_attachment", "delete_attachment", "open_full_board", "set_window_size", "close_window", "get_app_version", "check_update", "open_release_page", "broadcast_theme"]),
        ),
    )
    .expect("failed to run build script");
}
