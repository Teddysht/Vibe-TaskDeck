/* ============================================================
 * skill_install —— 「为 AI agent 安装 skill」命令层（v0.5.2）
 *
 * 挂件设置弹窗「AI 接入」组：检测本机已装的 AI agent
 * （Claude Code / Codex CLI），把本 skill 一键安装到其
 * skills 目录，装完即用——与挂件共用同一块看板。
 *
 * payload 三文件编译期内嵌 exe（include_str!，独立分发完整，
 * 不依赖源码目录）：
 *   SKILL.md / taskboard.py / config.example.json
 * 安装时额外自动生成 config.json（安装布局的关键）：
 *   widgetExe  = 当前 exe 真实路径（安装版即 Program Files 下）
 *   dataDir    = 当前数据目录（resolve_data_dir 三段解析同一份）
 *   runtimeDir = dataDir/runtime（状态文件与数据同根，好清理）
 *   skillVersion = 当前版本（前端显示「已安装 vX.Y.Z」）
 *
 * 目标布局（各家 agent 均为「复制即生效」，无注册步骤）：
 *   Claude Code: %USERPROFILE%\.claude\skills\Vibe-TaskDeck\
 *   Codex CLI:   %USERPROFILE%\.codex\skills\Vibe-TaskDeck\
 * 覆盖安装 = 更新（三 payload 重写 + config.json 重生成，幂等）。
 * ============================================================ */

use serde_json::{json, Value};

/// skill 文件在源码树的位置（相对本文件，编译期嵌入）
const SKILL_MD: &str = include_str!("../../../skill/SKILL.md");
const TASKBOARD_PY: &str = include_str!("../../../skill/taskboard.py");
const CONFIG_EXAMPLE: &str = include_str!("../../../skill/config.example.json");

const SKILL_DIR_NAME: &str = "Vibe-TaskDeck";

/// 支持的 agent 注册表（id 前端也用，改 id 属破坏性变更）
const AGENTS: [(&str, &str, &str); 2] = [
    // (agent id, 显示名, 检测根目录名)
    ("claude-code", "Claude Code", ".claude"),
    ("codex", "Codex CLI", ".codex"),
];

/// %USERPROFILE%（Windows 主目录；无则不可用）
fn user_profile() -> Option<std::path::PathBuf> {
    std::env::var("USERPROFILE")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(std::path::PathBuf::from)
}

/// agent id → 目标 skill 目录；agent 未装（根目录不存在）返回 None
fn skill_target_dir(agent_id: &str) -> Result<Option<std::path::PathBuf>, String> {
    let Some(home) = user_profile() else {
        return Err("无法定位用户主目录（USERPROFILE）".into());
    };
    let Some(&(_, _, root_name)) = AGENTS.iter().find(|(id, _, _)| *id == agent_id) else {
        return Err(format!("未知 agent：{agent_id}"));
    };
    let agent_root = home.join(root_name);
    if !agent_root.is_dir() {
        return Ok(None); // agent 未安装
    }
    Ok(Some(agent_root.join("skills").join(SKILL_DIR_NAME)))
}

/// 读已安装 skill 的 config.json → skillVersion（无 config / 无键 → None）
fn installed_version(target: &std::path::Path) -> Option<String> {
    let text = std::fs::read_to_string(target.join("config.json")).ok()?;
    serde_json::from_str::<Value>(&text)
        .ok()?
        .get("skillVersion")?
        .as_str()
        .map(|s| s.to_string())
}

/// 当前 exe 版本（与 CARGO_PKG_VERSION 同源；winres 嵌入的资源版本）
fn current_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// 生成安装布局 config.json：指向当前 exe 与数据目录（安装即用，
/// 免去手工配置 exe 路径/数据库位置的口径分裂问题）
fn generate_config() -> Result<String, String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("定位 exe 失败：{e}"))?
        .to_string_lossy()
        .to_string();
    let data_dir = crate::db::resolve_data_dir()?;
    let config = json!({
        "_comment": "由 Vibe-TaskDeck 挂件自动生成（设置 → AI 接入 → 安装）。widgetExe/dataDir 指向当前挂件与数据库，AI 经 taskboard.py 即与挂件同库操作。",
        "widgetExe": exe,
        "dataDir": data_dir.to_string_lossy(),
        "runtimeDir": data_dir.join("runtime").to_string_lossy(),
        "skillVersion": current_version(),
    });
    serde_json::to_string_pretty(&config).map_err(|e| format!("序列化 config 失败：{e}"))
}

/* ==== Tauri commands ==== */

/// 检测本机可安装的 agent：[{id, name, installed, version?}]
/// installed = skills 目录已存在本 skill；version 取自其 config.json
#[tauri::command]
pub fn detect_agents() -> Result<Vec<Value>, String> {
    let home = user_profile().ok_or("无法定位用户主目录（USERPROFILE）")?;
    let mut result = Vec::new();
    for (id, name, root_name) in AGENTS {
        let agent_root = home.join(root_name);
        let installed = skill_target_dir(id)
            .ok()
            .flatten()
            .map(|dir| dir.join("taskboard.py").is_file())
            .unwrap_or(false);
        let version = if installed {
            skill_target_dir(id).ok().flatten().and_then(|dir| installed_version(&dir))
        } else {
            None
        };
        result.push(json!({
            "id": id,
            "name": name,
            "agentInstalled": agent_root.is_dir(),
            "installed": installed,
            "version": version,
        }));
    }
    Ok(result)
}

/// 安装/更新 skill 到指定 agent。返回 {path, updated, version}；
/// agent 根目录不存在 → 明确错误（前端不应展示可安装态）。
#[tauri::command]
pub fn install_skill(agent: &str) -> Result<Value, String> {
    let Some(target) = skill_target_dir(agent)? else {
        let name = AGENTS.iter().find(|(id, _, _)| *id == agent).map(|(_, n, _)| *n).unwrap_or(agent);
        return Err(format!("{name} 未安装（找不到其主目录），请先安装 {name}"));
    };
    install_to(&target)
}

/// 写入目标目录（四文件：三 payload + 生成的 config.json）。
/// 独立于 command 层以便单测注入临时目录。
fn install_to(target: &std::path::Path) -> Result<Value, String> {
    let updated = target.join("taskboard.py").is_file();
    std::fs::create_dir_all(target).map_err(|e| format!("创建目录失败 {}: {e}", target.display()))?;
    let write = |name: &str, content: &str| -> Result<(), String> {
        std::fs::write(target.join(name), content).map_err(|e| format!("写入 {name} 失败：{e}"))
    };
    write("SKILL.md", SKILL_MD)?;
    write("taskboard.py", TASKBOARD_PY)?;
    write("config.example.json", CONFIG_EXAMPLE)?;
    write("config.json", &generate_config()?)?;
    Ok(json!({
        "path": target.to_string_lossy(),
        "updated": updated,
        "version": current_version(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payloads_are_embedded_and_nonempty() {
        // include_str 编译期已保证存在；这里钉住内容有效性
        assert!(SKILL_MD.starts_with("---"));
        assert!(SKILL_MD.contains("name: Vibe-TaskDeck"));
        assert!(TASKBOARD_PY.contains("def taskctl"));
        assert!(CONFIG_EXAMPLE.contains("widgetExe"));
        // skillVersion 键不进 example（自动生成的 config.json 才带版本）
        assert!(!CONFIG_EXAMPLE.contains("skillVersion"));
    }

    #[test]
    fn unknown_agent_is_rejected() {
        assert!(skill_target_dir("no-such-agent").is_err());
    }

    #[test]
    fn installed_version_reads_generated_config() {
        let dir = std::env::temp_dir().join(format!("td-skill-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(
            dir.join("config.json"),
            r#"{ "skillVersion": "0.5.2", "dataDir": "D:/x" }"#,
        )
        .unwrap();
        assert_eq!(installed_version(&dir).as_deref(), Some("0.5.2"));
        // 无 skillVersion 键 → None（旧版手工安装）
        std::fs::write(dir.join("config.json"), r#"{ "dataDir": "D:/x" }"#).unwrap();
        assert!(installed_version(&dir).is_none());
        // config 不存在 → None
        let _ = std::fs::remove_file(dir.join("config.json"));
        assert!(installed_version(&dir).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 完整安装链路（install_to + 生成 config 的三键）：临时目录注入，
    /// 不碰真实 ~/.claude。两轮安装验证幂等（updated false → true）。
    #[test]
    fn install_to_writes_payload_and_generated_config() {
        let dir = std::env::temp_dir().join(format!("td-skill-install-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // 数据目录三段解析受 VIBE_TASKDECK_DATA_DIR 影响：固定之（并行测试隔离）
        let prev = std::env::var("VIBE_TASKDECK_DATA_DIR").ok();
        std::env::set_var("VIBE_TASKDECK_DATA_DIR", dir.join("data"));
        {
            let first = install_to(&dir.join("skills").join(SKILL_DIR_NAME)).unwrap();
            assert_eq!(first["updated"], false);
            // 三 payload + config.json 四文件齐全
            for name in ["SKILL.md", "taskboard.py", "config.example.json", "config.json"] {
                assert!(dir.join("skills").join(SKILL_DIR_NAME).join(name).is_file(), "缺 {name}");
            }
            // 生成的 config 三键指向正确（dataDir 为注入的数据目录）
            let config: Value = serde_json::from_str(
                &std::fs::read_to_string(dir.join("skills").join(SKILL_DIR_NAME).join("config.json")).unwrap(),
            )
            .unwrap();
            // widgetExe = current_exe（cargo test 环境是 test runner 二进制，
            // 无法断言文件名——只钉非空 + 是绝对路径）
            let exe = config["widgetExe"].as_str().unwrap();
            assert!(!exe.is_empty() && std::path::Path::new(exe).is_absolute());
            assert_eq!(config["dataDir"].as_str().unwrap(), dir.join("data").to_string_lossy());
            assert_eq!(config["skillVersion"].as_str().unwrap(), current_version());
            // 安装后 detect_installed_version 可读回版本
            assert_eq!(
                installed_version(&dir.join("skills").join(SKILL_DIR_NAME)).as_deref(),
                Some(current_version().as_str())
            );
            // 第二轮 = 更新（幂等，updated=true）
            let second = install_to(&dir.join("skills").join(SKILL_DIR_NAME)).unwrap();
            assert_eq!(second["updated"], true);
        }
        // 恢复环境（同进程其他测试不受污染）
        match prev {
            Some(v) => std::env::set_var("VIBE_TASKDECK_DATA_DIR", v),
            None => std::env::remove_var("VIBE_TASKDECK_DATA_DIR"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
