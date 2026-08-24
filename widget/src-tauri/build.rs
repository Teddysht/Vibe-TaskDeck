use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::SystemTime;

// 递归收集目录下全部文件的修改时间，取最新
fn newest_mtime(dir: &Path, out: &mut Option<SystemTime>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            newest_mtime(&path, out);
        } else if let Ok(meta) = entry.metadata() {
            if let Ok(t) = meta.modified() {
                if out.is_none() || t > out.unwrap() {
                    *out = Some(t);
                }
            }
        }
    }
}

fn main() {
    // 前端构建挂进 cargo：widget/web/src 任一源文件比 widget/dist/mini.html 新
    // （或产物缺失）时自动重跑 build-widget.mjs，杜绝「改了前端忘了重跑构建、
    // exe 嵌入旧产物」的陈旧嵌入风险。node 不可用时告警并沿用现有 dist。
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let widget_root = manifest_dir
        .parent()
        .expect("src-tauri 的上级应为 widget/")
        .to_path_buf();
    let web_src = widget_root.join("web").join("src");
    let build_script = widget_root.join("scripts").join("build-widget.mjs");
    let dist = widget_root.join("dist").join("mini.html");

    // 源码或构建脚本变化 → 重跑本 build script
    println!("cargo:rerun-if-changed={}", web_src.display());
    println!("cargo:rerun-if-changed={}", build_script.display());

    let mut src_newest: Option<SystemTime> = None;
    newest_mtime(&web_src, &mut src_newest);
    let dist_mtime = dist.metadata().and_then(|m| m.modified()).ok();

    let stale = match (src_newest, dist_mtime) {
        (_, None) => true,                         // 产物缺失
        (Some(src_t), Some(dist_t)) => src_t > dist_t,
        (None, Some(_)) => false,                  // 无源码（异常但不阻断）
    };

    if stale {
        let node = if cfg!(target_os = "windows") { "node.exe" } else { "node" };
        match Command::new(node)
            .arg(&build_script)
            .current_dir(&widget_root)
            .status()
        {
            Ok(s) if s.success() => {}
            Ok(s) => panic!("build-widget.mjs 退出码非零: {s}"),
            Err(e) => println!(
                "cargo:warning=node 不可用，跳过前端重建（将嵌入现有 dist 产物）: {e}"
            ),
        }
    }

    // 显式声明自定义 command，为其自动生成 allow-$command 权限，
    // 使内嵌页面能通过 ACL 调用它们（纯客户端：load/create/move + 窗口控制）。
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new()
                .commands(&["load_data", "create_task", "move_task", "issue_detail", "add_comment", "open_full_board", "set_window_size", "close_window"]),
        ),
    )
    .expect("failed to run build script");
}
