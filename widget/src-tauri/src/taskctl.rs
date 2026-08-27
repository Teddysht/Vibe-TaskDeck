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
        "project create" => &["id", "name", "workspace-path", "binding-thread", "binding-codex-project-id", "binding-codex-project-kind", "binding-codex-host-id", "binding-workspace-path", "thread-id", "json"],
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
    /// db 层 ApiError 的等价物（exit 4）：code/message 逐字对齐 Node apiError(...) 抛出物
    fn api_code(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), exit_code: 4, details: None }
    }
    /// 文件 IO 失败（exit 2；对齐 Node TaskctlError FILE_READ/FILE_WRITE_FAILED + details）
    fn file_io(code: &'static str, message: impl Into<String>, details: String) -> Self {
        Self { code, message: message.into(), exit_code: 2, details: Some(details) }
    }
}

/// 409 语义错误码：VERSION_CONFLICT / PROJECT_EXISTS / RELATION_EXISTS
/// （对齐 taskctl-local normalizeError：status === 409 → 退出码 5）
const CONFLICT_CODES: [&str; 3] = ["VERSION_CONFLICT", "PROJECT_EXISTS", "RELATION_EXISTS"];

/// 版本冲突文案对齐 cli/database.mjs VERSION_CONFLICT_MESSAGE（逐字）
const VERSION_CONFLICT_MESSAGE: &str =
    "Task was modified by another session; reload and retry with the current version";

impl From<CommandError> for CliError {
    /// db 层错误 → CLI 信封：409 语义（版本冲突/项目已存在/关联已存在）→ 退出码 5，
    /// 其余按上游「HTTP 非 409 → 4」分发（db 层 code 与上游错误码同名）。
    /// VERSION_CONFLICT 文案替换为 Node 版原文（db 层中文文案服务挂件 GUI）。
    fn from(e: CommandError) -> Self {
        let exit_code = if CONFLICT_CODES.contains(&e.code) { 5 } else { 4 };
        let message = if e.code == "VERSION_CONFLICT" {
            VERSION_CONFLICT_MESSAGE.to_string()
        } else {
            e.message
        };
        Self { code: leak_code(e.code), message, exit_code, details: None }
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
        "PROJECT_EXISTS" => "PROJECT_EXISTS",
        "TASK_ARCHIVED" => "TASK_ARCHIVED",
        "TASK_NOT_ARCHIVED" => "TASK_NOT_ARCHIVED",
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
    /// --if-version 显式版本；缺省 None（由调用方自动取当前版本）。
    /// 非正整数校验对齐 taskctl-local resolveVersion（usage 错误）
    fn if_version(&self) -> Result<Option<i64>, CliError> {
        match self.opt("if-version") {
            None => Ok(None),
            Some(v) => match v.parse::<i64>() {
                Ok(version) if version >= 1 => Ok(Some(version)),
                _ => Err(CliError::usage("--if-version must be a positive integer")),
            },
        }
    }
    /// 会话归属解析（对齐 taskctl-local resolveThreadId：显式 --thread-id >
    /// CODEX_THREAD_ID；trim；超 256 字符拒绝）
    /// actor：env 覆盖（多 AI 区分），默认 codex-agent（对齐 resolveActor）
    fn actor(&self) -> (String, String) {
        let raw_id = std::env::var("VIBE_TASKDECK_ACTOR_ID").ok().map(|s| s.trim().to_string());
        let id_set = raw_id.as_deref().map(|s| !s.is_empty()).unwrap_or(false);
        let id = if id_set { raw_id.clone().unwrap() } else { "codex-agent".into() };
        let raw_name = std::env::var("VIBE_TASKDECK_ACTOR_NAME").ok().map(|s| s.trim().to_string());
        let name = if raw_name.as_deref().map(|s| !s.is_empty()).unwrap_or(false) {
            raw_name.unwrap()
        } else if id_set {
            id.clone()
        } else {
            "Codex Agent".into()
        };
        (id, name)
    }

    fn thread_id(&self) -> Result<String, CliError> {
        let value = self
            .opt("thread-id")
            .map(|s| s.to_string())
            .or_else(|| std::env::var("CODEX_THREAD_ID").ok());
        let Some(value) = value else {
            return Err(CliError::usage(
                "Codex conversation attribution requires --thread-id or CODEX_THREAD_ID",
            ));
        };
        let thread_id = value.trim().to_string();
        if thread_id.is_empty() {
            return Err(CliError::usage(
                "Codex conversation attribution requires --thread-id or CODEX_THREAD_ID",
            ));
        }
        if thread_id.chars().count() > 256 {
            return Err(CliError::usage("--thread-id and CODEX_THREAD_ID cannot exceed 256 characters"));
        }
        Ok(thread_id)
    }
}

/// actor：env 覆盖（多 AI 区分），默认 codex-agent/Codex Agent
/// （对齐 taskctl-local resolveActor：仅覆盖 ID 未覆盖 NAME 时 NAME 回退为 ID）
fn default_actor() -> (String, String) {
    let raw_id = std::env::var("VIBE_TASKDECK_ACTOR_ID")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let id = raw_id.clone().unwrap_or_else(|| "codex-agent".into());
    let name = std::env::var("VIBE_TASKDECK_ACTOR_NAME")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| match raw_id {
            Some(_) => id.clone(),
            None => "Codex Agent".into(),
        });
    (id, name)
}

fn validate_options(parsed: &Parsed) -> Result<(), CliError> {
    let command = parsed.command();
    let Some(allowed) = allowed_options(&command) else { return Ok(()) };
    for (name, _) in &parsed.options {
        if !allowed.contains(&name.as_str()) {
            // 文案对齐 taskctl-local validateOptions
            return Err(CliError::usage(format!("Unknown option --{name}")));
        }
    }
    Ok(())
}

/// 位置参数个数校验（文案对齐 taskctl-local expectOperandCount）
fn expect_operands(parsed: &Parsed, count: usize) -> Result<(), CliError> {
    if parsed.operands.len() != count {
        if count == 0 {
            Err(CliError::usage(format!(
                "{} {} does not accept positional arguments",
                parsed.resource.as_deref().unwrap_or(""),
                parsed.action.as_deref().unwrap_or("")
            )))
        } else {
            Err(CliError::usage(format!(
                "{} {} requires exactly {count} positional {}",
                parsed.resource.as_deref().unwrap_or(""),
                parsed.action.as_deref().unwrap_or(""),
                if count == 1 { "argument" } else { "arguments" }
            )))
        }
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
            project_list(conn)
        }
        "project create" => {
            expect_operands(parsed, 0)?;
            project_create(conn, parsed)
        }
        "issue list" => {
            expect_operands(parsed, 0)?;
            issue_list(conn, parsed)
        }
        "issue get" => {
            expect_operands(parsed, 1)?;
            issue_get(conn, &parsed.operands[0])
        }
        "issue create" => {
            expect_operands(parsed, 0)?;
            issue_create(conn, parsed)
        }
        "issue update" => {
            expect_operands(parsed, 1)?;
            issue_update(conn, &parsed.operands[0], parsed)
        }
        "issue move" => {
            expect_operands(parsed, 1)?;
            issue_move(conn, &parsed.operands[0], parsed)
        }
        "issue archive" => {
            expect_operands(parsed, 1)?;
            issue_archive_restore(conn, &parsed.operands[0], parsed, true)
        }
        "issue restore" => {
            expect_operands(parsed, 1)?;
            issue_archive_restore(conn, &parsed.operands[0], parsed, false)
        }
        "issue relation" => {
            expect_operands(parsed, 2)?;
            issue_relation(conn, &parsed.operands, parsed)
        }
        "activity list" => {
            expect_operands(parsed, 0)?;
            activity_list(conn, parsed)
        }
        "context current" => {
            expect_operands(parsed, 0)?;
            context_current(conn, parsed)
        }
        "comment list" => {
            expect_operands(parsed, 1)?;
            let task_id = require_operand_id(&parsed.operands[0], "issue")?;
            Ok(json!({ "comments": db::list_comments_cli(conn, task_id)? }))
        }
        "comment add" => {
            expect_operands(parsed, 1)?;
            // 校验顺序对齐 Node commentAdd：thread-id → issue id → body
            let thread_id = thread_id_for_comment(parsed)?;
            let task_id = require_operand_id(&parsed.operands[0], "issue")?;
            let body = required_option(parsed, "body")?;
            let (actor_id, actor_name) = parsed.actor();
            let comment =
                db::create_comment_cli(conn, task_id, &body, &thread_id, ("agent", &actor_id, &actor_name))?;
            Ok(json!({ "comment": comment }))
        }
        "comment update" => {
            expect_operands(parsed, 1)?;
            // 校验顺序对齐 Node commentUpdate：thread-id → if-version → comment id → body
            let thread_id = thread_id_for_comment(parsed)?;
            let version = explicit_version(parsed)?;
            let comment_id = require_operand_id(&parsed.operands[0], "comment")?;
            let body = required_option(parsed, "body")?;
            Ok(json!({ "comment": db::update_comment_cli(conn, comment_id, version, &body, &thread_id)? }))
        }
        "comment delete" => {
            expect_operands(parsed, 1)?;
            // 对齐上游：删除也要 thread-id；校验顺序 thread-id → if-version → comment id
            thread_id_for_comment(parsed)?;
            let version = explicit_version(parsed)?;
            let comment_id = require_operand_id(&parsed.operands[0], "comment")?;
            db::delete_comment_cli(conn, comment_id, version)?;
            // 对齐 HTTP 204 空响应：taskctl 原样输出仅含 schemaVersion 的 JSON
            Ok(json!({}))
        }
        "attachment upload" => attachment_upload(conn, parsed),
        "attachment download" => {
            expect_operands(parsed, 1)?;
            attachment_download(conn, &parsed.operands[0], parsed)
        }
        _ => Err(CliError::api(format!("Command '{command}' not yet implemented in widget CLI"))),
    }
}

/* ============================================================
 * 命令实现（输出契约逐字对齐 cli/taskctl-local.mjs）
 * ============================================================ */

/// Node 版 TASK_NOT_FOUND 文案（requireIssueId 后由 db 层抛出）
fn task_not_found(id: &str) -> CliError {
    CliError::api_code("TASK_NOT_FOUND", format!("Task '{id}' does not exist"))
}

fn assert_status(status: &str) -> Result<(), CliError> {
    if db::TASK_STATUSES.contains(&status) {
        Ok(())
    } else {
        Err(CliError::usage(format!(
            "Invalid status: {status}. Expected one of: {}",
            db::TASK_STATUSES.join(", ")
        )))
    }
}

fn assert_priority(priority: &str) -> Result<(), CliError> {
    if db::TASK_PRIORITIES.contains(&priority) {
        Ok(())
    } else {
        Err(CliError::usage(format!("Invalid priority: {priority}")))
    }
}

/// 长度校验（对齐 taskctl-local assertStringLength → INVALID_FIELD / exit 4）
fn assert_string_length(value: &str, name: &str, max_length: usize) -> Result<(), CliError> {
    if value.chars().count() > max_length {
        Err(CliError::api_code(
            "INVALID_FIELD",
            format!("'{name}' must be a string of at most {max_length} characters"),
        ))
    } else {
        Ok(())
    }
}

/// labels 逗号切分（对齐 taskctl-local parseLabels：trim + 去空 + 去重保序）
fn parse_labels(raw: Option<&str>) -> Vec<String> {
    match raw {
        None | Some("") => Vec::new(),
        Some(text) => {
            let mut labels: Vec<String> = Vec::new();
            for label in text.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()) {
                if !labels.contains(&label.to_string()) {
                    labels.push(label.to_string());
                }
            }
            labels
        }
    }
}

/// --if-version 解析（对齐 taskctl-local resolveVersion）：
/// 显式给值直接用；缺省自动取任务当前版本（任务须存在）
fn resolve_version(conn: &Connection, id: &str, explicit: Option<i64>) -> Result<i64, CliError> {
    if let Some(version) = explicit {
        return Ok(version);
    }
    db::task_version(conn, id)
        .map(|(_, version)| version)
        .ok_or_else(|| task_not_found(id))
}

/// agent actor（对齐 taskctl-local resolveActor：VIBE_TASKDECK_ACTOR_ID/NAME env 覆盖）
fn agent_actor() -> db::Actor {
    let (id, name) = default_actor();
    db::Actor::agent(&id, &name)
}

/// project list：宽形状 + local 的 workspacePath 强制 null（对齐 projectList）
fn project_list(conn: &Connection) -> Result<Value, CliError> {
    let projects: Vec<Value> = db::list_projects_full(conn)
        .into_iter()
        .map(|mut project| {
            if project["id"] == "local" {
                project["workspacePath"] = Value::Null;
            }
            project
        })
        .collect();
    Ok(json!({ "projects": projects }))
}

/// project id 合法性（对齐 taskctl-local PROJECT_ID_PATTERN：
/// ^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$）
fn valid_project_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    if bytes.is_empty() || bytes.len() > 64 {
        return false;
    }
    let alnum = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    if !alnum(bytes[0]) || !alnum(bytes[bytes.len() - 1]) {
        return false;
    }
    bytes.iter().all(|b| alnum(*b) || *b == b'-')
}

/// 项目 id slug 生成（对齐 taskctl-local slugify：小写、非字母数字折叠为 -、去首尾 -、截 64）
fn slugify(value: &str) -> String {
    let mut slug = String::new();
    let mut in_dash = false;
    for ch in value.to_lowercase().chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            slug.push(ch);
            in_dash = false;
        } else if !in_dash && !slug.is_empty() {
            slug.push('-');
            in_dash = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    slug.chars().take(64).collect()
}

/// 相对路径 → 绝对路径（对齐 taskctl-local resolveInputPath：基于进程 cwd；
/// 词法归一化 . / .. 分量，对齐 Node path.resolve 的清理语义）
fn resolve_input_path(value: &str) -> std::path::PathBuf {
    let path = std::path::PathBuf::from(value);
    let joined = if path.is_absolute() {
        path
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let mut normalized = std::path::PathBuf::new();
    for component in joined.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

/// project create（校验对齐 taskctl-local projectCreate）
fn project_create(conn: &Connection, parsed: &Parsed) -> Result<Value, CliError> {
    let name = parsed.opt_required("name")?;
    assert_string_length(&name, "name", 120)?;
    let id = match parsed.opt("id") {
        Some(explicit) => explicit.to_string(),
        None => slugify(&name),
    };
    if id.is_empty() {
        return Err(CliError::api_code(
            "INVALID_FIELD",
            "Project name must contain at least one letter or number when 'id' is omitted",
        ));
    }
    if !valid_project_id(&id) {
        return Err(CliError::api_code(
            "INVALID_FIELD",
            "'id' must be a lowercase slug containing letters, numbers, or hyphens",
        ));
    }
    let workspace_path = parsed.opt("workspace-path").map(resolve_input_path);
    // 注：binding-* 选项在本数据层无存储位（projects 表无绑定列），接受但忽略
    let project = db::create_project(
        conn,
        &id,
        &name,
        workspace_path.as_ref().map(|p| p.to_string_lossy().to_string()).as_deref(),
    )?;
    Ok(json!({ "project": project }))
}

/// issue list（过滤语义对齐 taskctl-local issueList；扩展 M2 骨架声明的
/// priority/assignee/creator/label/search 过滤位）
fn issue_list(conn: &Connection, parsed: &Parsed) -> Result<Value, CliError> {
    if let Some(status) = parsed.opt("status") {
        assert_status(status)?;
    }
    if let Some(priority) = parsed.opt("priority") {
        assert_priority(priority)?;
    }
    // 未传 --archived 只看未归档（对齐路由默认值）；all 不按归档过滤
    let archived = match parsed.opt("archived") {
        None => Some(false),
        Some("true") => Some(true),
        Some("false") => Some(false),
        Some("all") => None,
        Some(_) => return Err(CliError::usage("--archived must be true, false, or all")),
    };
    let filter = db::TaskListFilter {
        project_id: parsed.opt("project"),
        status: parsed.opt("status"),
        priority: parsed.opt("priority"),
        assignee_id: parsed.opt("assignee"),
        creator_id: parsed.opt("creator"),
        label: parsed.opt("label"),
        thread_id: parsed.opt("thread-id"),
        archived,
        search: parsed.opt("search"),
    };
    Ok(json!({ "tasks": db::list_tasks_full(conn, &filter) }))
}

/// issue get：{task: 宽形状 + comments + activities}
fn issue_get(conn: &Connection, id: &str) -> Result<Value, CliError> {
    let task = db::get_task_full(conn, id).ok_or_else(|| task_not_found(id))?;
    Ok(json!({ "task": task }))
}

/// issue create（对齐 taskctl-local issueCreate；--project 缺省 local）
fn issue_create(conn: &Connection, parsed: &Parsed) -> Result<Value, CliError> {
    let status = parsed.opt("status").unwrap_or("backlog");
    assert_status(status)?;
    let priority = parsed.opt("priority").unwrap_or("none");
    assert_priority(priority)?;

    let project_id = parsed.opt("project").unwrap_or("local").to_string();
    let title = parsed.opt_required("title")?;
    assert_string_length(&title, "title", 240)?;
    if title.is_empty() {
        return Err(CliError::api_code("INVALID_FIELD", "'title' cannot be empty"));
    }
    if !db::project_exists(conn, &project_id) {
        return Err(CliError::api_code(
            "PROJECT_NOT_FOUND",
            format!("Project '{project_id}' does not exist"),
        ));
    }

    let thread_id = parsed.thread_id()?;
    let actor = agent_actor();
    let labels = parse_labels(parsed.opt("labels"));
    let assignee = parsed.opt("assignee").map(|id| db::Actor::agent(id, id));
    let spec = db::TaskCreateSpec {
        project_id: &project_id,
        title: &title,
        description: parsed.opt("description").unwrap_or(""),
        status,
        priority,
        labels: &labels,
        thread_id: Some(&thread_id),
        start_date: parsed.opt("start-date"),
        due_date: parsed.opt("due-date"),
        assignee: assignee.as_ref(),
    };
    let task = db::create_task_ex(conn, &spec, &actor)?;
    Ok(json!({ "task": task }))
}

/// issue update（对齐 taskctl-local issueUpdate；assignee 为 M2 骨架选项扩展）
fn issue_update(conn: &Connection, id: &str, parsed: &Parsed) -> Result<Value, CliError> {
    if let Some(status) = parsed.opt("status") {
        assert_status(status)?;
    }
    if let Some(priority) = parsed.opt("priority") {
        assert_priority(priority)?;
    }
    if let Some(title) = parsed.opt("title") {
        assert_string_length(title, "title", 240)?;
        if title.is_empty() {
            return Err(CliError::api_code("INVALID_FIELD", "'title' cannot be empty"));
        }
    }

    let mut changes = serde_json::Map::new();
    for (option, field) in [
        ("title", "title"),
        ("description", "description"),
        ("status", "status"),
        ("priority", "priority"),
        ("assignee", "assignee"),
        ("start-date", "startDate"),
        ("due-date", "dueDate"),
    ] {
        if let Some(value) = parsed.opt(option) {
            changes.insert(field.to_string(), json!(value));
        }
    }
    if let Some(labels) = parsed.opt("labels") {
        changes.insert("labels".to_string(), json!(parse_labels(Some(labels))));
    }
    if changes.is_empty() {
        return Err(CliError::usage("issue update requires at least one field to update"));
    }

    let (real_id, current_version) = db::task_version(conn, id)
        .ok_or_else(|| task_not_found(id))?;
    let version = resolve_version(conn, id, parsed.if_version()?)?;
    let _ = current_version;
    let thread_id = parsed.thread_id()?;
    let actor = agent_actor();
    db::update_task(conn, &real_id, version, &Value::Object(changes), Some(&thread_id), &actor)?;
    let task = db::get_task_wide(conn, &real_id).unwrap_or(Value::Null);
    Ok(json!({ "task": task }))
}

/// issue move（对齐 taskctl-local issueMove；--sort-order 为 M2 骨架选项扩展）
fn issue_move(conn: &Connection, id: &str, parsed: &Parsed) -> Result<Value, CliError> {
    let status = parsed.opt_required("status")?;
    assert_status(&status)?;
    let sort_order = match parsed.opt("sort-order") {
        None => None,
        Some(raw) => Some(raw.parse::<f64>().map_err(|_| {
            CliError::usage(format!("Invalid --sort-order value: {raw}"))
        })?),
    };
    let (real_id, _) = db::task_version(conn, id).ok_or_else(|| task_not_found(id))?;
    let version = resolve_version(conn, id, parsed.if_version()?)?;
    let thread_id = parsed.thread_id()?;
    let actor = agent_actor();
    db::move_task(conn, &real_id, version, &status, sort_order, Some(&thread_id), &actor)?;
    let task = db::get_task_wide(conn, &real_id).unwrap_or(Value::Null);
    Ok(json!({ "task": task }))
}

/// issue archive / issue restore（对齐 taskctl-local issueArchive）
fn issue_archive_restore(conn: &Connection, id: &str, parsed: &Parsed, archive: bool) -> Result<Value, CliError> {
    let (real_id, _) = db::task_version(conn, id).ok_or_else(|| task_not_found(id))?;
    let version = resolve_version(conn, id, parsed.if_version()?)?;
    parsed.thread_id()?;
    let actor = agent_actor();
    if archive {
        db::archive_task(conn, &real_id, version, &actor)?;
    } else {
        db::restore_task(conn, &real_id, version, &actor)?;
    }
    let task = db::get_task_wide(conn, &real_id).unwrap_or(Value::Null);
    Ok(json!({ "task": task }))
}

/// issue relation add/remove（对齐 taskctl-local issueRelation；写语义接线 db.rs
/// add_relation/remove_relation，输出 {task, relatedTask} 宽形状详情）
fn issue_relation(conn: &Connection, operands: &[String], parsed: &Parsed) -> Result<Value, CliError> {
    let (action, task_id) = (&operands[0], &operands[1]);
    if action != "add" && action != "remove" {
        return Err(CliError::usage("issue relation action must be add or remove"));
    }
    let relation_type = parsed.opt_required("type")?;
    if !["parent", "blocks", "blocked_by", "related"].contains(&relation_type.as_str()) {
        return Err(CliError::usage("--type must be parent, blocks, blocked_by, or related"));
    }
    let related_raw = parsed.opt_required("issue")?;
    let (real_id, _) = db::task_version(conn, task_id).ok_or_else(|| task_not_found(task_id))?;
    let version = resolve_version(conn, task_id, parsed.if_version()?)?;
    parsed.thread_id()?;
    let _ = agent_actor(); // db.rs 关联路径不写活动流（对齐 Node：thread/actor 仅为签名保留）

    if action == "add" {
        let real_related = db::resolve_task_id(conn, &related_raw)
            .ok_or_else(|| task_not_found(&related_raw))?;
        db::add_relation(conn, &real_id, version, &relation_type, &real_related)?;
        Ok(json!({
            "task": db::get_task_full(conn, &real_id).unwrap_or(Value::Null),
            "relatedTask": db::get_task_full(conn, &real_related).unwrap_or(Value::Null),
        }))
    } else {
        // remove：related 存在性不强制（对齐 Node #taskRow(relatedId)?.id ?? relatedId）
        let real_related = db::resolve_task_id(conn, &related_raw).unwrap_or_else(|| related_raw.clone());
        db::remove_relation(conn, &real_id, version, &relation_type, &real_related)?;
        Ok(json!({
            "task": db::get_task_full(conn, &real_id).unwrap_or(Value::Null),
            "relatedTask": db::get_task_full(conn, &real_related).unwrap_or(Value::Null),
        }))
    }
}

/// activity list（对齐 taskctl-local activityList：nextSinceId 游标回传）
fn activity_list(conn: &Connection, parsed: &Parsed) -> Result<Value, CliError> {
    let since_id = parsed.opt("since-id");
    if since_id == Some("") {
        return Err(CliError::usage("--since-id cannot be empty"));
    }
    let activities = db::list_activity_feed(conn, parsed.opt("thread-id"), since_id);
    let next_since_id = activities
        .last()
        .map(|activity| activity["id"].clone())
        .unwrap_or_else(|| since_id.map(Value::from).unwrap_or(Value::Null));
    Ok(json!({ "activities": activities, "nextSinceId": next_since_id }))
}

/// context current（对齐 taskctl-local currentContext：workspaceContains 最长前缀优先）
fn context_current(conn: &Connection, parsed: &Parsed) -> Result<Value, CliError> {
    let cwd = match parsed.opt("cwd") {
        Some(value) => resolve_input_path(value),
        None => std::env::current_dir().unwrap_or_default(),
    };
    let projects = db::list_projects_full(conn);
    let mut matching: Vec<&Value> = projects
        .iter()
        .filter(|project| {
            project["workspacePath"]
                .as_str()
                .filter(|p| !p.is_empty())
                .map(|workspace| workspace_contains(workspace, &cwd))
                .unwrap_or(false)
        })
        .collect();
    // 最长 workspacePath 优先（对齐 Node 的长度降序排序）
    matching.sort_by(|left, right| {
        let left_len = left["workspacePath"].as_str().map_or(0, str::len);
        let right_len = right["workspacePath"].as_str().map_or(0, str::len);
        right_len.cmp(&left_len)
    });
    let project = matching
        .first()
        .copied()
        .or_else(|| projects.iter().find(|p| p["id"] == "local"))
        .or_else(|| projects.first())
        .cloned()
        .unwrap_or(Value::Null);
    Ok(json!({ "cwd": cwd.to_string_lossy(), "project": project }))
}

/// workspaceContains（对齐 taskctl-local：path.relative 非越界即包含；
/// Rust 用 strip_prefix 分量级判定，ParentDir 分量视为越界）
fn workspace_contains(workspace_path: &str, cwd: &std::path::Path) -> bool {
    let base = std::path::Path::new(workspace_path);
    match cwd.strip_prefix(base) {
        Ok(relative) => {
            relative.as_os_str().is_empty()
                || !relative
                    .components()
                    .any(|c| matches!(c, std::path::Component::ParentDir))
        }
        Err(_) => false,
    }
}

/* ==== comment + attachment 簇（M3-B；契约逐字对齐 cli/taskctl-local.mjs） ==== */

/// --thread-id 解析（完整校验，对齐 Node resolveThreadId：显式选项 > env，
/// trim 非空、≤256 字符）。取值链复用 M2 的 Parsed::thread_id（显式 > env），
/// 其缺失文案与 Node 不同——在此按 Node 契约重写；空白/长度校验为 Node 独有
fn thread_id_for_comment(parsed: &Parsed) -> Result<String, CliError> {
    let raw = parsed.thread_id().map_err(|_| {
        CliError::usage("Codex conversation attribution requires --thread-id or CODEX_THREAD_ID")
    })?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(CliError::usage(
            "Codex conversation attribution requires --thread-id or CODEX_THREAD_ID",
        ));
    }
    if trimmed.chars().count() > 256 {
        return Err(CliError::usage("--thread-id and CODEX_THREAD_ID cannot exceed 256 characters"));
    }
    Ok(trimmed.to_string())
}

/// --if-version（comment update/delete 专用）：必填正整数（对齐 Node
/// explicitVersion）。评论写端点与 issue 簇不同——上游强制显式版本，
/// 不做「缺省自动取当前」
fn explicit_version(parsed: &Parsed) -> Result<i64, CliError> {
    let Some(raw) = parsed.opt("if-version") else {
        return Err(CliError::usage("Missing required option --if-version"));
    };
    match raw.parse::<i64>() {
        Ok(v) if v >= 1 => Ok(v),
        _ => Err(CliError::usage("--if-version must be a positive integer")),
    }
}

/// 必填选项（对齐 Node requiredOption：缺失或空串均报 usage 错误）
fn required_option(parsed: &Parsed, name: &str) -> Result<String, CliError> {
    match parsed.opt(name) {
        Some(v) if !v.is_empty() => Ok(v.to_string()),
        _ => Err(CliError::usage(format!("Missing required option --{name}"))),
    }
}

/// 位置参数 id 非空校验（对齐 Node requireIssueId / requireCommentId）
fn require_operand_id<'a>(value: &'a str, kind: &str) -> Result<&'a str, CliError> {
    if value.is_empty() {
        return Err(CliError::usage(format!("Missing {kind} id")));
    }
    Ok(value)
}

/// 扩展名 → Content-Type（移植上游 taskctl.mjs #guessContentType，
/// 与 Node 版映射及默认值逐字一致）
fn guess_content_type(filename: &str) -> &'static str {
    let ext = std::path::Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "md" => "text/markdown",
        "txt" => "text/plain",
        "json" => "application/json",
        "pdf" => "application/pdf",
        "html" | "htm" => "text/html",
        _ => "application/octet-stream",
    }
}

/// 附件目录（复用 db::attachments_dir：VIBE_TASKDECK_DATA_DIR > APPDATA，
/// 与挂件同根互通）；不可定位对齐 Node SERVICE_UNAVAILABLE（exit 3）
fn attachments_dir_or_unavailable() -> Result<std::path::PathBuf, CliError> {
    db::attachments_dir().ok_or_else(|| CliError {
        code: "SERVICE_UNAVAILABLE",
        message: "Cannot locate the taskboard data directory. Set VIBE_TASKDECK_DATA_DIR.".into(),
        exit_code: 3,
        details: None,
    })
}

fn file_write_failed(path: &std::path::Path, error: &std::io::Error) -> CliError {
    CliError::file_io(
        "FILE_WRITE_FAILED",
        format!("Cannot write attachment file: {}", path.to_string_lossy()),
        error.to_string(),
    )
}

/// attachment upload：--task 与 --comment 恰好其一；先读源文件、先校验目标
/// 存在，后写盘（UUID 文件名）入库——顺序逐字对齐 Node attachmentUpload
fn attachment_upload(conn: &Connection, parsed: &Parsed) -> Result<Value, CliError> {
    let task_opt = parsed.opt("task").map(str::to_string);
    let comment_opt = parsed.opt("comment").map(str::to_string);
    if task_opt.is_some() == comment_opt.is_some() {
        return Err(CliError::usage("attachment upload requires exactly one of --task or --comment"));
    }

    let file_path = resolve_input_path(&required_option(parsed, "file")?);
    let file_str = file_path.to_string_lossy().to_string();
    let bytes = std::fs::read(&file_path).map_err(|error| {
        CliError::file_io(
            "FILE_READ_FAILED",
            format!("Cannot read attachment file: {file_str}"),
            error.to_string(),
        )
    })?;

    let filename = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string();
    if filename.is_empty() || filename == "." || filename == ".." {
        return Err(CliError::usage("Attachment --file must include a valid filename"));
    }

    let content_type = match parsed.opt("content-type") {
        Some(value) => {
            let trimmed = value.trim().to_lowercase();
            if trimmed.is_empty() {
                return Err(CliError::usage("--content-type cannot be empty"));
            }
            trimmed
        }
        None => guess_content_type(&filename).to_string(),
    };

    // 目标存在性前置校验（对齐 Node：先查后写盘，避免失败留孤儿文件）；
    // --task 支持 identifier 寻址
    let (target_type, target_id) = if let Some(task_id) = &task_opt {
        if db::task_id_cli(conn, task_id).is_none() {
            return Err(CliError::api_code("TASK_NOT_FOUND", format!("Task '{task_id}' does not exist")));
        }
        ("task", task_id.clone())
    } else {
        let comment_id = comment_opt.as_deref().unwrap_or_default();
        if db::get_comment_cli(conn, comment_id).is_none() {
            return Err(CliError::api_code(
                "COMMENT_NOT_FOUND",
                format!("Comment '{comment_id}' does not exist"),
            ));
        }
        ("comment", comment_id.to_string())
    };

    if bytes.len() > 10 * 1024 * 1024 {
        return Err(CliError::api_code("ATTACHMENT_TOO_LARGE", "Attachment cannot exceed 10MB"));
    }

    // 先写盘（UUID 文件名）后入库，顺序对齐 db.rs #upload_attachment / Node
    let dir = attachments_dir_or_unavailable()?;
    let id = uuid::Uuid::new_v4().to_string();
    let disk_path = dir.join(&id);
    std::fs::create_dir_all(&dir).map_err(|error| file_write_failed(&disk_path, &error))?;
    std::fs::write(&disk_path, &bytes).map_err(|error| file_write_failed(&disk_path, &error))?;

    let attachment = db::create_attachment_cli(
        conn,
        &id,
        task_opt.as_deref(),
        comment_opt.as_deref(),
        &filename,
        &content_type,
        bytes.len() as i64,
    )?;
    Ok(json!({
        "attachment": attachment,
        "file": file_str,
        "target": { "type": target_type, "id": target_id },
    }))
}

/// attachment download：operand 须为 UUID（对齐 db.rs sanitize_attachment_id）；
/// DB 行与磁盘文件缺任一 → ATTACHMENT_NOT_FOUND；写盘失败 FILE_WRITE_FAILED（exit 2）
fn attachment_download(conn: &Connection, attachment_id: &str, parsed: &Parsed) -> Result<Value, CliError> {
    if db::sanitize_attachment_id(attachment_id).is_none() {
        return Err(CliError::api_code(
            "INVALID_FIELD",
            format!("Invalid attachment id: {attachment_id}"),
        ));
    }
    let attachment = db::get_attachment_cli(conn, attachment_id).ok_or_else(|| {
        CliError::api_code("ATTACHMENT_NOT_FOUND", format!("Attachment '{attachment_id}' does not exist"))
    })?;

    let dir = attachments_dir_or_unavailable()?;
    let bytes = std::fs::read(dir.join(attachment_id)).map_err(|_| {
        // DB 行在而磁盘文件缺失：对齐 db.rs #read_attachment 的 ATTACHMENT_NOT_FOUND
        CliError::api_code("ATTACHMENT_NOT_FOUND", format!("Attachment file missing: {attachment_id}"))
    })?;

    let output_path = resolve_input_path(&required_option(parsed, "output")?);
    let output_str = output_path.to_string_lossy().to_string();
    std::fs::write(&output_path, &bytes).map_err(|error| file_write_failed(&output_path, &error))?;
    Ok(json!({
        "attachmentId": attachment_id,
        "output": output_str,
        "contentType": attachment["contentType"],
        "size": bytes.len(),
    }))
}
