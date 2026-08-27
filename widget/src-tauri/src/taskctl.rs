/* ============================================================
 * taskctl —— AI 任务命令行（exe 双模式的 CLI 分支）
 *
 * 入口判定（main.rs）：argv[1] == "taskctl" 时走本模块，不启动
 * WebView。数据层直接复用 db.rs（同库不分裂：CLI 与挂件 GUI
 * 共用同一份 Rust 实现，语义对齐成本归零）。
 *
 * 输出契约与 cli/taskctl-local.mjs / 上游 taskctl 逐字对齐：
 *   - stdout 成功信封：{...result, schemaVersion: 2}
 *   - stderr 错误信封：{schemaVersion: 2, error: {code, message[, details]}}
 *   - 退出码：0 成功 / 2 非法输入 / 3 环境不可用 / 4 API 错误 / 5 冲突
 *
 * windows_subsystem = "windows"（release）下进程默认无控制台，
 * CLI 模式须 AttachConsole(ATTACH_PARENT_PROCESS) 并重绑 stdio，
 * 否则管道/终端都收不到输出（Tauri 混合 exe 的经典坑）。
 * ============================================================ */

use crate::db::{self, CommandError};
use rusqlite::Connection;
use serde_json::{json, Value};

const SCHEMA_VERSION: i64 = 2;
const USAGE: &str = "Expected one of: project list/create, issue list/get/create/update/move/archive/restore/relation, comment list/add/update/delete, attachment download/upload, activity list, context current";

/// 本地模式不支持的命令（纯客户端无 server，语义不适用）——
/// 给出明确指引而非笼统 usage 错误（对齐 taskctl-local 的 UNSUPPORTED_COMMANDS）
const UNSUPPORTED_COMMANDS: [&str; 5] = ["project map", "cloud login", "cloud status", "cloud logout", "issue delete"];

/// 布尔选项（不接受值；对齐 taskctl-local BOOLEAN_OPTIONS）
const BOOLEAN_OPTIONS: [&str; 2] = ["json", "clear-binding-thread"];

/// 各命令允许的选项集合（逐字对齐上游 COMMAND_OPTIONS 本地子集）
fn allowed_options(command: &str) -> Option<&'static [&'static str]> {
    Some(match command {
        "project list" => &["json"],
        "project create" => &["name", "workspace-path", "binding-thread", "binding-codex-project-id", "binding-codex-project-kind", "binding-codex-host-id", "binding-workspace-path", "thread-id", "json"],
        "issue list" => &["project", "status", "priority", "assignee", "creator", "label", "thread-id", "archived", "search", "json"],
        "issue get" => &["json"],
        "issue create" => &["project", "title", "description", "status", "priority", "labels", "assignee", "thread-id", "start-date", "due-date", "json"],
        "issue update" => &["title", "description", "status", "priority", "labels", "assignee", "start-date", "due-date", "thread-id", "if-version", "json"],
        "issue move" => &["status", "sort-order", "thread-id", "if-version", "json"],
        "issue archive" => &["thread-id", "if-version", "json"],
        "issue restore" => &["thread-id", "if-version", "json"],
        "issue relation" => &["type", "issue", "thread-id", "if-version", "json"],
        "comment list" => &["json"],
        "comment add" => &["body", "thread-id", "json"],
        "comment update" => &["body", "thread-id", "if-version", "json"],
        "comment delete" => &["thread-id", "if-version", "json"],
        "attachment download" => &["output", "json"],
        "attachment upload" => &["file", "task", "comment", "content-type", "json"],
        "activity list" => &["thread-id", "since-id", "json"],
        "context current" => &["cwd", "json"],
        _ => return None,
    })
}

/* ==== 错误类型：code + 退出码（对齐 TaskctlError） ==== */

struct CliError {
    code: &'static str,
    message: String,
    exit_code: i32,
    details: Option<String>,
}

impl CliError {
    fn usage(message: impl Into<String>) -> Self {
        Self { code: "USAGE_ERROR", message: message.into(), exit_code: 2, details: None }
    }
    fn api(message: impl Into<String>) -> Self {
        Self { code: "API_ERROR", message: message.into(), exit_code: 4, details: None }
    }
}

impl From<CommandError> for CliError {
    /// db 层错误 → CLI 信封：VERSION_CONFLICT 是 409 语义 → 退出码 5，
    /// 其余按上游「HTTP 非 409 → 4」分发（db 层 code 与上游错误码同名）
    fn from(e: CommandError) -> Self {
        let exit_code = if e.code == "VERSION_CONFLICT" { 5 } else { 4 };
        Self { code: leak_code(e.code), message: e.message, exit_code, details: None }
    }
}

/// db 层错误码是 &'static str（CommandError.code），直接转存
fn leak_code(code: &str) -> &'static str {
    match code {
        "DB_ERROR" => "DB_ERROR",
        "TASK_NOT_FOUND" => "TASK_NOT_FOUND",
        "VERSION_CONFLICT" => "VERSION_CONFLICT",
        "INVALID_FIELD" => "INVALID_FIELD",
        "RELATION_EXISTS" => "RELATION_EXISTS",
        "RELATION_NOT_FOUND" => "RELATION_NOT_FOUND",
        "ATTACHMENT_NOT_FOUND" => "ATTACHMENT_NOT_FOUND",
        "ATTACHMENT_TOO_LARGE" => "ATTACHMENT_TOO_LARGE",
        "PROJECT_NOT_FOUND" => "PROJECT_NOT_FOUND",
        "COMMENT_NOT_FOUND" => "COMMENT_NOT_FOUND",
        _ => "API_ERROR",
    }
}

/* ==== argv 解析（手写，语法对齐 taskctl-local parseArgs） ==== */

struct Parsed {
    resource: Option<String>,
    action: Option<String>,
    operands: Vec<String>,
    options: Vec<(String, Option<String>)>, // (name, Some(value) | None=布尔)
}

fn parse_args(argv: &[String]) -> Result<Parsed, CliError> {
    let mut positionals: Vec<String> = Vec::new();
    let mut options: Vec<(String, Option<String>)> = Vec::new();

    let mut index = 0;
    while index < argv.len() {
        let token = &argv[index];
        if token == "--" {
            positionals.extend(argv[index + 1..].iter().cloned());
            break;
        }
        if !token.starts_with("--") {
            positionals.push(token.clone());
            index += 1;
            continue;
        }
        let body = &token[2..];
        let (name, eq_value): (&str, Option<&str>) = match body.find('=') {
            Some(i) => (&body[..i], Some(&body[i + 1..])),
            None => (body, None),
        };
        if name.is_empty() {
            return Err(CliError::usage("Invalid empty option"));
        }
        if options.iter().any(|(n, _)| n == name) {
            return Err(CliError::usage(format!("Option --{name} may only be specified once")));
        }
        if BOOLEAN_OPTIONS.contains(&name) {
            if eq_value.is_some() {
                return Err(CliError::usage(format!("Option --{name} does not accept a value")));
            }
            options.push((name.to_string(), None));
            index += 1;
            continue;
        }
        match eq_value {
            Some(v) => options.push((name.to_string(), Some(v.to_string()))),
            None => {
                let value = argv.get(index + 1);
                match value {
                    Some(v) if !v.starts_with("--") => {
                        options.push((name.to_string(), Some(v.clone())));
                        index += 1;
                    }
                    _ => return Err(CliError::usage(format!("Option --{name} requires a value"))),
                }
            }
        }
        index += 1;
    }

    Ok(Parsed {
        resource: positionals.first().cloned(),
        action: positionals.get(1).cloned(),
        operands: positionals[2.min(positionals.len())..].to_vec(),
        options,
    })
}

impl Parsed {
    fn command(&self) -> String {
        format!("{} {}", self.resource.as_deref().unwrap_or(""), self.action.as_deref().unwrap_or(""))
            .trim()
            .to_string()
    }
    fn opt(&self, name: &str) -> Option<&str> {
        self.options
            .iter()
            .find(|(n, _)| n == name)
            .and_then(|(_, v)| v.as_deref())
    }
    fn opt_required(&self, name: &str) -> Result<String, CliError> {
        self.opt(name)
            .map(|s| s.to_string())
            .ok_or_else(|| CliError::usage(format!("Missing required option --{name}")))
    }
    /// --if-version 显式版本；缺省 None（由调用方决定自动取当前或报错）
    fn if_version(&self) -> Result<Option<i64>, CliError> {
        match self.opt("if-version") {
            None => Ok(None),
            Some(v) => v
                .parse::<i64>()
                .map(Some)
                .map_err(|_| CliError::usage(format!("Invalid --if-version value: {v}"))),
        }
    }
    fn thread_id(&self) -> Result<String, CliError> {
        // Mana 场景无 CODEX_THREAD_ID；env 缺省回退 upstream 惯例名（与
        // taskctl-local resolveThreadId 一致：显式 --thread-id > env）
        self.opt("thread-id")
            .map(|s| s.to_string())
            .or_else(|| std::env::var("CODEX_THREAD_ID").ok())
            .ok_or_else(|| CliError::usage("Missing required option --thread-id"))
    }
    /// actor：env 覆盖（多 AI 区分），默认 codex-agent（对齐 resolveActor）
    fn actor(&self) -> (String, String) {
        let id = std::env::var("VIBE_TASKDECK_ACTOR_ID")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "codex-agent".into());
        let name = std::env::var("VIBE_TASKDECK_ACTOR_NAME")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| if std::env::var("VIBE_TASKDECK_ACTOR_ID").map(|v| !v.trim().is_empty()).unwrap_or(false) { id.clone() } else { "Codex Agent".into() });
        (id, name)
    }
}

fn validate_options(parsed: &Parsed) -> Result<(), CliError> {
    let command = parsed.command();
    let Some(allowed) = allowed_options(&command) else { return Ok(()) };
    for (name, _) in &parsed.options {
        if !allowed.contains(&name.as_str()) {
            return Err(CliError::usage(format!("Unknown option --{name} for '{command}'")));
        }
    }
    Ok(())
}

fn expect_operands(parsed: &Parsed, count: usize) -> Result<(), CliError> {
    if parsed.operands.len() != count {
        Err(CliError::usage(format!(
            "'{}' expects exactly {count} operand(s), got {}",
            parsed.command(),
            parsed.operands.len()
        )))
    } else {
        Ok(())
    }
}

/* ==== CLI 主流程 ==== */

/// CLI 入口（main.rs 在 argv[1] == "taskctl" 时调用）。
/// 返回进程退出码；stdout/stderr 已在 main 里 AttachConsole 重绑。
pub fn run_cli(argv: &[String]) -> i32 {
    // argv 传入时已剥掉 "taskctl" 本身；空参打 usage
    let result = if argv.is_empty() {
        Err(CliError::usage(USAGE))
    } else {
        execute(argv)
    };
    match result {
        Ok(value) => {
            let mut envelope = value;
            if let Value::Object(map) = &mut envelope {
                map.insert("schemaVersion".into(), json!(SCHEMA_VERSION));
            }
            println!("{}", serde_json::to_string(&envelope).unwrap_or_default());
            0
        }
        Err(e) => {
            let mut error = json!({ "code": e.code, "message": e.message });
            if let Some(d) = e.details {
                error["details"] = json!(d);
            }
            eprintln!("{}", serde_json::to_string(&json!({ "schemaVersion": SCHEMA_VERSION, "error": error })).unwrap_or_default());
            e.exit_code
        }
    }
}

fn execute(argv: &[String]) -> Result<Value, CliError> {
    let parsed = parse_args(argv)?;
    let command = parsed.command();

    if UNSUPPORTED_COMMANDS.contains(&command.as_str()) {
        return Err(CliError {
            code: "UNSUPPORTED_LOCAL",
            message: format!(
                "Local mode does not support '{command}'. The pure-client build has no server; use the widget UI (fullboard detail panel) instead."
            ),
            exit_code: 2,
            details: None,
        });
    }
    if allowed_options(&command).is_none() {
        return Err(CliError::usage(USAGE));
    }
    validate_options(&parsed)?;

    // 短生命周期：CLI 每次调用即开即关（与挂件长连接 WAL 并发安全）
    let conn = db::open_database().map_err(|message| CliError {
        code: "SERVICE_UNAVAILABLE",
        message,
        exit_code: 3,
        details: None,
    })?;

    dispatch(&conn, &command, &parsed)
}

fn dispatch(conn: &Connection, command: &str, parsed: &Parsed) -> Result<Value, CliError> {
    match command {
        "project list" => {
            expect_operands(parsed, 0)?;
            Ok(json!({ "projects": db::list_projects(conn) }))
        }
        // M3 迁移中：未实现的命令先落 here（CLI 骨架先行，命令逐簇补齐）
        _ => Err(CliError::api(format!("Command '{command}' not yet implemented in widget CLI"))),
    }
}
