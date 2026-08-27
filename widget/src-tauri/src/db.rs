/* ============================================================
 * db —— 数据层：连接管理 + schema + 挂件子集 CRUD
 *
 * 与 upstream/server/database.mjs 保持兼容：
 *   · DDL 逐字对齐 #migrate()（database.mjs:408-500）
 *   · PRAGMA 三件套一致（WAL / busy_timeout 5000 / foreign_keys）
 *   · create_task / move_task 逐条对齐 upstream 的事务与版本并发语义
 * 挂件只实现所需子集；完整形状（comments/activity/relations）由
 * cli/taskctl-local.mjs 直连 Node TaskboardDatabase 提供，不经此层。
 * ============================================================ */

use std::path::PathBuf;

use rusqlite::Connection;
use serde_json::{json, Value};

/// 与上游 shared/domain.mjs 的 DEFAULT_LABEL_NAMES 一致（projects.labels 默认值）
const DEFAULT_PROJECT_LABELS_JSON: &str = "[\"缺陷\",\"特性\",\"for-claude\",\"hold\",\"改进\",\"phase-1\",\"phase-2\",\"phase-3\",\"phase-4\",\"phase-5\",\"phase-6\"]";

/// 挂件写操作的稳定 thread 标识（对齐 widget config.js 的 THREAD_ID）
pub const WIDGET_THREAD_ID: &str = "taskboard-widget";

/// 挂件侧 actor：本地用户（与上游 app.mjs 无头请求的默认 actor 一致）。
/// 单机单用户假设的产物——未来多成员在此预留 env 覆盖点
/// （VIBE_TASKDECK_USER_ID/NAME，与 AI 侧 VIBE_TASKDECK_ACTOR_* 对称），
/// 详见 TECHNICAL.md「已知技术债」。
const LOCAL_USER_ACTOR: (&str, &str, &str) = ("user", "local-user", "本地用户");

pub const TASK_STATUSES: [&str; 7] = ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled"];
pub const TASK_PRIORITIES: [&str; 5] = ["none", "urgent", "high", "medium", "low"];

/// 写操作身份（挂件=本地用户；taskctl CLI=agent——由 taskctl 按
/// VIBE_TASKDECK_ACTOR_* env 解析后传入，对齐 cli/taskctl-local.mjs resolveActor）
#[derive(Clone, Debug)]
pub struct Actor {
    pub kind: String, // "user" | "agent"
    pub id: String,
    pub name: String,
    pub avatar_url: Option<String>,
}

impl Actor {
    /// agent actor（taskctl CLI 写路径；name 缺省回退 id 的规则在 taskctl 侧）
    pub fn agent(id: &str, name: &str) -> Self {
        Self { kind: "agent".into(), id: id.into(), name: name.into(), avatar_url: None }
    }
}

/// 挂件 GUI 写路径的固定本地用户 actor（行为与旧版固定 LOCAL_USER_ACTOR 一致）
pub fn local_user_actor() -> Actor {
    Actor { kind: "user".into(), id: "local-user".into(), name: "本地用户".into(), avatar_url: None }
}

/// 托管状态：进程内单连接（command 层持锁使用）
pub struct Db(pub std::sync::Mutex<Connection>);

/// command 层错误：序列化为 {code, message}，前端用 e.code 识别 VERSION_CONFLICT
#[derive(Debug)]
pub struct CommandError {
    pub code: &'static str,
    pub message: String,
}

impl CommandError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

impl serde::Serialize for CommandError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("CommandError", 2)?;
        state.serialize_field("code", &self.code)?;
        state.serialize_field("message", &self.message)?;
        state.end()
    }
}

impl From<rusqlite::Error> for CommandError {
    fn from(error: rusqlite::Error) -> Self {
        CommandError::new("DB_ERROR", format!("数据库错误：{error}"))
    }
}

/// 打开（必要时创建）数据库：路径解析 + PRAGMA + 建表 + seed
pub fn open_database() -> Result<Connection, String> {
    let path = resolve_db_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建数据目录失败 {}: {e}", parent.display()))?;
    }
    let conn = Connection::open(&path).map_err(|e| format!("打开数据库失败 {}: {e}", path.display()))?;
    conn.execute_batch(
        "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;",
    )
    .map_err(|e| format!("设置 PRAGMA 失败：{e}"))?;
    migrate(&conn).map_err(|e| format!("初始化表结构失败：{e}"))?;
    seed_local_project(&conn).map_err(|e| format!("初始化默认项目失败：{e}"))?;
    Ok(conn)
}

/// 数据库路径：VIBE_TASKDECK_DATA_DIR > %APPDATA%\Vibe-TaskDeck
/// （与 cli/taskctl-local.mjs、upstream server 的解析规则保持一致，三方同库）
fn resolve_db_path() -> Result<PathBuf, String> {
    if let Ok(dir) = std::env::var("VIBE_TASKDECK_DATA_DIR") {
        let dir = dir.trim();
        if !dir.is_empty() {
            return Ok(PathBuf::from(dir).join("taskboard.sqlite"));
        }
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        let appdata = appdata.trim();
        if !appdata.is_empty() {
            return Ok(PathBuf::from(appdata).join("Vibe-TaskDeck").join("taskboard.sqlite"));
        }
    }
    Err("无法定位数据目录：请设置 VIBE_TASKDECK_DATA_DIR 环境变量".into())
}

/// 建表：4 张核心表 + 3 个索引，DDL 逐字对齐 upstream database.mjs #migrate()
/// （其余表由 Node 端打开同库时自动补建，这里不重复）
fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(&format!(
        r#"
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        workspace_path TEXT,
        labels TEXT NOT NULL DEFAULT '{DEFAULT_PROJECT_LABELS_JSON}',
        next_task_number INTEGER NOT NULL DEFAULT 1 CHECK (next_task_number > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        identifier TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN (
          'backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled'
        )),
        priority TEXT NOT NULL CHECK (priority IN ('none', 'urgent', 'high', 'medium', 'low')),
        labels TEXT NOT NULL DEFAULT '[]',
        sort_order REAL NOT NULL,
        thread_id TEXT,
        thread_codex_project_id TEXT,
        thread_codex_project_kind TEXT,
        thread_codex_host_id TEXT,
        thread_workspace_path TEXT,
        creator_type TEXT NOT NULL DEFAULT 'user',
        creator_id TEXT NOT NULL DEFAULT 'local-user',
        creator_name TEXT NOT NULL DEFAULT '本地用户',
        creator_avatar_url TEXT,
        assignee_type TEXT NOT NULL DEFAULT 'user' CHECK (assignee_type IN ('user', 'agent')),
        assignee_id TEXT NOT NULL DEFAULT 'local-user',
        assignee_name TEXT NOT NULL DEFAULT '本地用户',
        assignee_avatar_url TEXT,
        workflow_id TEXT,
        git_branch TEXT,
        worktree_path TEXT,
        worktree_branch TEXT,
        start_date TEXT,
        due_date TEXT,
        recurrence_interval INTEGER,
        recurrence_unit TEXT,
        external_source TEXT,
        external_origin TEXT,
        external_id TEXT,
        external_key TEXT,
        external_url TEXT,
        archived_at TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS tasks_project_status_sort
        ON tasks(project_id, archived_at, status, sort_order, created_at);

      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        thread_id TEXT,
        thread_codex_project_id TEXT,
        thread_codex_project_kind TEXT,
        thread_codex_host_id TEXT,
        thread_workspace_path TEXT,
        author_type TEXT NOT NULL DEFAULT 'user',
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_avatar_url TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS comments_task_created
        ON comments(task_id, created_at, id);

      CREATE TABLE IF NOT EXISTS task_activities (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent')),
        actor_id TEXT NOT NULL,
        actor_name TEXT NOT NULL,
        actor_avatar_url TEXT,
        changes TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS task_activities_task_created
        ON task_activities(task_id, created_at, id);

      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS attachments_task_created
        ON attachments(task_id, created_at, id);

      CREATE INDEX IF NOT EXISTS attachments_comment_created
        ON attachments(comment_id, created_at, id);

      CREATE TABLE IF NOT EXISTS task_relations (
        relation_type TEXT NOT NULL CHECK (relation_type IN ('parent', 'blocks', 'related')),
        source_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        target_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        CHECK (source_task_id <> target_task_id),
        CHECK (relation_type <> 'related' OR source_task_id < target_task_id),
        PRIMARY KEY (relation_type, source_task_id, target_task_id)
      );

      CREATE INDEX IF NOT EXISTS task_relations_target
        ON task_relations(relation_type, target_task_id);

      CREATE UNIQUE INDEX IF NOT EXISTS task_relations_one_parent
        ON task_relations(target_task_id)
        WHERE relation_type = 'parent';
        "#
    ))
}

/// seed 默认项目 local「全局」，对齐 upstream database.mjs:818-827
fn seed_local_project(conn: &Connection) -> rusqlite::Result<()> {
    let timestamp = now_iso();
    conn.execute(
        "INSERT INTO projects (id, name, workspace_path, next_task_number, created_at, updated_at)
         VALUES ('local', '全局', NULL, 1, ?1, ?2)
         ON CONFLICT(id) DO NOTHING",
        rusqlite::params![timestamp, timestamp],
    )?;
    conn.execute(
        "UPDATE projects
         SET name = '全局', workspace_path = NULL, updated_at = ?1
         WHERE id = 'local' AND (name != '全局' OR workspace_path IS NOT NULL)",
        rusqlite::params![timestamp],
    )?;
    Ok(())
}

/// UTC ISO8601（毫秒 3 位 + Z），对齐 Node new Date().toISOString()
fn now_iso() -> String {
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = elapsed.as_secs() as i64;
    let millis = elapsed.subsec_millis();
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// 当前时刻回退 offset_secs 秒的 UTC ISO（毫秒 3 位 + Z，与 now_iso 同格式）。
/// CLI report 的时间窗过滤用（ISO 定长格式可安全按字典序比较）。
pub fn now_iso_minus(offset_secs: i64) -> String {
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let target = (elapsed.as_secs() as i64 - offset_secs).max(0);
    let millis = elapsed.subsec_millis();
    let days = target.div_euclid(86_400);
    let rem = target.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// 数据目录（VIBE_TASKDECK_DATA_DIR > %APPDATA%\Vibe-TaskDeck）。
/// taskctl sync 游标文件等 CLI 侧状态文件的落点（与 resolve_db_path 同解析规则）。
pub fn cli_data_dir() -> Result<std::path::PathBuf, String> {
    if let Ok(dir) = std::env::var("VIBE_TASKDECK_DATA_DIR") {
        let dir = dir.trim();
        if !dir.is_empty() {
            return Ok(PathBuf::from(dir));
        }
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        let appdata = appdata.trim();
        if !appdata.is_empty() {
            return Ok(PathBuf::from(appdata).join("Vibe-TaskDeck"));
        }
    }
    Err("无法定位数据目录：请设置 VIBE_TASKDECK_DATA_DIR 环境变量".into())
}

/// epoch 天数 → 公历年月日（Howard Hinnant civil_from_days 算法）
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as i64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if month <= 2 { y + 1 } else { y }, month, day)
}

/// 一次返回挂件所需全部数据
pub fn load_data(conn: &Connection) -> Value {
    json!({ "tasks": list_tasks(conn), "projects": list_projects(conn) })
}

/// 任务列表：挂件子集字段，ORDER BY 逐字对齐 upstream listTasks（database.mjs:1663-1679）
pub fn list_tasks(conn: &Connection) -> Vec<Value> {
    let mut stmt = match conn.prepare(
        "SELECT id, identifier, project_id, title, description, status, priority, labels, sort_order,
                thread_id, start_date, due_date, archived_at, version, created_at, updated_at,
                creator_type, creator_name
         FROM tasks
         ORDER BY
           CASE status
             WHEN 'backlog' THEN 1
             WHEN 'todo' THEN 2
             WHEN 'in_progress' THEN 3
             WHEN 'in_review' THEN 4
             WHEN 'blocked' THEN 5
             WHEN 'done' THEN 6
             WHEN 'canceled' THEN 7
           END,
           sort_order, created_at, id",
    ) {
        Ok(stmt) => stmt,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map([], |row| {
        Ok(TaskColumns {
            id: row.get(0)?,
            identifier: row.get(1)?,
            project_id: row.get(2)?,
            title: row.get(3)?,
            description: row.get(4)?,
            status: row.get(5)?,
            priority: row.get(6)?,
            labels: row.get(7)?,
            sort_order: row.get(8)?,
            thread_id: row.get(9)?,
            start_date: row.get(10)?,
            due_date: row.get(11)?,
            archived_at: row.get(12)?,
            version: row.get(13)?,
            created_at: row.get(14)?,
            updated_at: row.get(15)?,
            creator_type: row.get(16)?,
            creator_name: row.get(17)?,
        })
    });
    match rows {
        Ok(rows) => rows.filter_map(|r| r.ok()).map(task_to_json).collect(),
        Err(_) => Vec::new(),
    }
}

/// 项目列表：挂件只需要 id/name
pub fn list_projects(conn: &Connection) -> Vec<Value> {
    let mut stmt = match conn.prepare("SELECT id, name, labels FROM projects ORDER BY created_at, id") {
        Ok(stmt) => stmt,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    });
    match rows {
        Ok(rows) => rows
            .filter_map(|r| r.ok())
            .map(|(id, name, labels)| {
                json!({ "id": id, "name": name, "labels": serde_json::from_str::<Value>(&labels).unwrap_or(json!([])) })
            })
            .collect(),
        Err(_) => Vec::new(),
    }
}

#[derive(Debug)]
struct TaskColumns {
    id: String,
    identifier: String,
    project_id: String,
    title: String,
    description: String,
    status: String,
    priority: String,
    labels: String,
    sort_order: f64,
    thread_id: Option<String>,
    start_date: Option<String>,
    due_date: Option<String>,
    archived_at: Option<String>,
    version: i64,
    created_at: String,
    updated_at: String,
    creator_type: String,
    creator_name: String,
}

fn task_to_json(t: TaskColumns) -> Value {
    let labels: Value = serde_json::from_str(&t.labels).unwrap_or(json!([]));
    json!({
        "id": t.id,
        "identifier": t.identifier,
        "projectId": t.project_id,
        "title": t.title,
        "description": t.description,
        "status": t.status,
        "priority": t.priority,
        "labels": labels,
        "sortOrder": t.sort_order,
        "threadId": t.thread_id,
        "startDate": t.start_date,
        "dueDate": t.due_date,
        "archivedAt": t.archived_at,
        "version": t.version,
        "createdAt": t.created_at,
        "updatedAt": t.updated_at,
        "creatorType": t.creator_type,
        "creatorName": t.creator_name,
    })
}

fn get_task_columns(conn: &Connection, id: &str) -> rusqlite::Result<Option<TaskColumns>> {
    let mut stmt = conn.prepare(
        "SELECT id, identifier, project_id, title, description, status, priority, labels, sort_order,
                thread_id, start_date, due_date, archived_at, version, created_at, updated_at,
                creator_type, creator_name
         FROM tasks WHERE id = ?1 OR identifier = ?1",
    )?;
    let mut rows = stmt.query_map(rusqlite::params![id], |row| {
        Ok(TaskColumns {
            id: row.get(0)?,
            identifier: row.get(1)?,
            project_id: row.get(2)?,
            title: row.get(3)?,
            description: row.get(4)?,
            status: row.get(5)?,
            priority: row.get(6)?,
            labels: row.get(7)?,
            sort_order: row.get(8)?,
            thread_id: row.get(9)?,
            start_date: row.get(10)?,
            due_date: row.get(11)?,
            archived_at: row.get(12)?,
            version: row.get(13)?,
            created_at: row.get(14)?,
            updated_at: row.get(15)?,
            creator_type: row.get(16)?,
            creator_name: row.get(17)?,
        })
    })?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

/// 新建任务：对齐 upstream createTask（database.mjs:1702-1801）的事务与 identifier/sortOrder 语义
pub fn create_task(
    conn: &Connection,
    title: &str,
    status: &str,
    priority: &str,
    due_date: Option<&str>,
    actor: &Actor,
) -> Result<Value, CommandError> {
    // —— 校验（upstream 路由层 parseTaskCreate 的等价规则）——
    if title.is_empty() || title.chars().count() > 240 {
        return Err(CommandError::new("INVALID_FIELD", "title 必填且不超过 240 字符"));
    }
    if !TASK_STATUSES.contains(&status) {
        return Err(CommandError::new("INVALID_FIELD", format!("非法 status：{status}")));
    }
    if !TASK_PRIORITIES.contains(&priority) {
        return Err(CommandError::new("INVALID_FIELD", format!("非法 priority：{priority}")));
    }
    // 挂件口径固定 local 项目 / WIDGET_THREAD_ID / 空描述无标签（与旧版行为一致）
    let spec = TaskCreateSpec {
        project_id: "local",
        title,
        description: "",
        status,
        priority,
        labels: &[],
        thread_id: Some(WIDGET_THREAD_ID),
        start_date: None,
        due_date,
        assignee: None,
    };
    create_task_ex(conn, &spec, actor)
}

/// CLI（taskctl issue create）全量建任务入参。
/// 语义逐条对齐 cli/database.mjs #createTask：identifier 前缀、sortOrder 缺省、
/// 项目标签库合并去重、creator/assignee 落 actor。
pub struct TaskCreateSpec<'a> {
    pub project_id: &'a str,
    pub title: &'a str,
    pub description: &'a str,
    pub status: &'a str,
    pub priority: &'a str,
    pub labels: &'a [String],
    pub thread_id: Option<&'a str>,
    pub start_date: Option<&'a str>,
    pub due_date: Option<&'a str>,
    /// None → assignee = actor（对齐 taskctl-local issueCreate 的 assignee: actor）
    pub assignee: Option<&'a Actor>,
}

/// 新建任务（CLI 宽口径）：返回 CLI 宽形状 task（27 字段，task_full_json）。
/// 事务 + identifier/sortOrder 语义对齐 upstream createTask（database.mjs:1702-1801）。
pub fn create_task_ex(conn: &Connection, spec: &TaskCreateSpec, actor: &Actor) -> Result<Value, CommandError> {
    if spec.title.is_empty() || spec.title.chars().count() > 240 {
        return Err(CommandError::new("INVALID_FIELD", "title 必填且不超过 240 字符"));
    }
    if !TASK_STATUSES.contains(&spec.status) {
        return Err(CommandError::new("INVALID_FIELD", format!("非法 status：{}", spec.status)));
    }
    if !TASK_PRIORITIES.contains(&spec.priority) {
        return Err(CommandError::new("INVALID_FIELD", format!("非法 priority：{}", spec.priority)));
    }

    conn.execute_batch("BEGIN IMMEDIATE")?;
    let result = create_task_ex_inner(conn, spec, actor);
    match result {
        Ok(task) => {
            conn.execute_batch("COMMIT")?;
            Ok(task)
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

fn create_task_ex_inner(
    conn: &Connection,
    spec: &TaskCreateSpec,
    actor: &Actor,
) -> Result<Value, CommandError> {
    struct ProjectRow {
        labels: String,
        next_task_number: i64,
        first_identifier: Option<String>,
    }
    let project: ProjectRow = conn
        .query_row(
            "SELECT labels, next_task_number,
                    (SELECT tasks.identifier FROM tasks
                     WHERE tasks.project_id = projects.id
                     ORDER BY tasks.created_at, tasks.id LIMIT 1) AS first_identifier
             FROM projects WHERE id = ?1",
            rusqlite::params![spec.project_id],
            |row| {
                Ok(ProjectRow {
                    labels: row.get(0)?,
                    next_task_number: row.get(1)?,
                    first_identifier: row.get(2)?,
                })
            },
        )
        .map_err(|_| CommandError::new("PROJECT_NOT_FOUND", format!("项目不存在：{}", spec.project_id)))?;

    // identifier 前缀：项目首个任务 identifier 去掉尾部 -数字，否则项目 id 大写去非字母数字截 12
    let prefix: String = match &project.first_identifier {
        Some(first) => match first.rsplit_once('-') {
            Some((head, tail))
                if !head.is_empty()
                    && !tail.is_empty()
                    && tail.chars().all(|c| c.is_ascii_digit()) =>
            {
                head.to_string()
            }
            _ => project_prefix(spec.project_id),
        },
        None => project_prefix(spec.project_id),
    };

    let glob = format!("{prefix}-[0-9]*");
    let maximum: Option<i64> = conn.query_row(
        "SELECT MAX(CAST(substr(identifier, ?1) AS INTEGER)) AS number
         FROM tasks WHERE identifier GLOB ?2",
        rusqlite::params![prefix.chars().count() + 2, glob],
        |row| row.get(0),
    )?;
    let number = project.next_task_number.max(maximum.map_or(1, |m| m + 1));
    let identifier = format!("{prefix}-{number}");
    let id = uuid::Uuid::new_v4().to_string();
    let timestamp = now_iso();

    // sortOrder 缺省 = 同项目同状态未归档最小值 − 1000（无则 1000）
    let minimum: Option<f64> = conn.query_row(
        "SELECT MIN(sort_order) FROM tasks
         WHERE project_id = ?1 AND status = ?2 AND archived_at IS NULL",
        rusqlite::params![spec.project_id, spec.status],
        |row| row.get(0),
    )?;
    let sort_order = minimum.map_or(1000.0, |min| min - 1000.0);

    // 任务 labels 去重（保序）；项目标签库合并去重回写（对齐 Node createTask #mergeLabels）
    let mut labels: Vec<String> = Vec::new();
    for label in spec.labels {
        if !labels.contains(label) {
            labels.push(label.clone());
        }
    }
    let mut catalog: Vec<String> = serde_json::from_str(&project.labels).unwrap_or_default();
    for label in &labels {
        if !catalog.contains(label) {
            catalog.push(label.clone());
        }
    }
    conn.execute(
        "UPDATE projects SET next_task_number = ?1, labels = ?2, updated_at = ?3 WHERE id = ?4",
        rusqlite::params![
            number + 1,
            serde_json::to_string(&catalog).unwrap_or_else(|_| "[]".into()),
            timestamp,
            spec.project_id
        ],
    )?;

    // assignee 缺省 = actor（对齐 taskctl-local issueCreate：assignee: actor）
    let assignee = spec.assignee.unwrap_or(actor);
    conn.execute(
        "INSERT INTO tasks (
           id, identifier, project_id, title, description, status, priority, labels,
           sort_order, thread_id, thread_codex_project_id, thread_codex_project_kind,
           thread_codex_host_id, thread_workspace_path,
           creator_type, creator_id, creator_name, creator_avatar_url,
           assignee_type, assignee_id, assignee_name, assignee_avatar_url,
           workflow_id, git_branch, worktree_path, worktree_branch,
           start_date, due_date, recurrence_interval, recurrence_unit,
           archived_at, version, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
                   ?9, ?10, NULL, NULL, NULL, NULL,
                   ?11, ?12, ?13, ?14,
                   ?15, ?16, ?17, ?18,
                   NULL, NULL, NULL, NULL,
                   ?19, ?20, NULL, NULL,
                   NULL, 1, ?21, ?21)",
        rusqlite::params![
            id,
            identifier,
            spec.project_id,
            spec.title,
            spec.description,
            spec.status,
            spec.priority,
            serde_json::to_string(&labels).unwrap_or_else(|_| "[]".into()),
            sort_order,
            spec.thread_id,
            actor.kind,
            actor.id,
            actor.name,
            actor.avatar_url,
            assignee.kind,
            assignee.id,
            assignee.name,
            assignee.avatar_url,
            spec.start_date,
            spec.due_date,
            timestamp,
        ],
    )?;

    task_wide_by_id(conn, &id)?
        .ok_or_else(|| CommandError::new("DB_ERROR", "创建后读取任务失败"))
}

/// 流转任务：对齐 upstream moveTask（database.mjs:1942-1992）
/// sortOrder：显式传入（拖拽落点排序）优先；缺省按上游惯例（状态变化→min−1000；未变→max+1000）
/// thread_id：Some → 随迁移重写会话归属（挂件传 WIDGET_THREAD_ID，CLI 传解析后的
/// --thread-id）；None → 保持当前值（Node moveTask 的 threadId ?? current.thread_id）
pub fn move_task(
    conn: &Connection,
    id: &str,
    version: i64,
    status: &str,
    sort_order: Option<f64>,
    thread_id: Option<&str>,
    actor: &Actor,
) -> Result<Value, CommandError> {
    if !TASK_STATUSES.contains(&status) {
        return Err(CommandError::new("INVALID_FIELD", format!("非法 status：{status}")));
    }
    let current = get_task_columns(conn, id)?
        .ok_or_else(|| CommandError::new("TASK_NOT_FOUND", format!("任务不存在：{id}")))?;
    if current.version != version {
        return Err(CommandError::new("VERSION_CONFLICT", "任务已被其他会话修改，请重试"));
    }
    if current.archived_at.is_some() {
        return Err(CommandError::new("TASK_ARCHIVED", "已归档任务不能流转"));
    }

    // sortOrder 缺省逻辑：状态变化 → 目标状态最小值 − 1000；未变 → 当前状态最大值 + 1000
    let sort_order = match sort_order {
        Some(explicit) => explicit,
        None if status != current.status => {
            let minimum: Option<f64> = conn.query_row(
                "SELECT MIN(sort_order) FROM tasks
                 WHERE project_id = ?1 AND status = ?2 AND archived_at IS NULL AND id != ?3",
                rusqlite::params![current.project_id, status, current.id],
                |row| row.get(0),
            )?;
            minimum.map_or(1000.0, |min| min - 1000.0)
        }
        None => {
            let maximum: f64 = conn.query_row(
                "SELECT COALESCE(MAX(sort_order), 0) FROM tasks
                 WHERE project_id = ?1 AND status = ?2 AND archived_at IS NULL AND id != ?3",
                rusqlite::params![current.project_id, status, current.id],
                |row| row.get(0),
            )?;
            maximum + 1000.0
        }
    };

    let timestamp = now_iso();
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let result = (|| -> Result<Value, CommandError> {
        let updated = conn.execute(
            "UPDATE tasks
             SET status = ?1, sort_order = ?2,
                 thread_id = COALESCE(?3, thread_id),
                 thread_codex_project_id = NULL, thread_codex_project_kind = NULL,
                 thread_codex_host_id = NULL, thread_workspace_path = NULL,
                 version = version + 1, updated_at = ?4
             WHERE id = ?5 AND version = ?6",
            rusqlite::params![status, sort_order, thread_id, timestamp, current.id, version],
        )?;
        if updated != 1 {
            return Err(CommandError::new(
                "VERSION_CONFLICT",
                "任务已被其他会话修改，请重试",
            ));
        }
        // 状态实际变化时记录活动流（Node 端 getTask 会读取）
        if status != current.status {
            let changes = json!([{ "field": "status", "before": current.status, "after": status }]);
            conn.execute(
                "INSERT INTO task_activities (
                   id, task_id, actor_type, actor_id, actor_name, actor_avatar_url, changes, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                rusqlite::params![
                    uuid::Uuid::new_v4().to_string(),
                    current.id,
                    actor.kind,
                    actor.id,
                    actor.name,
                    actor.avatar_url,
                    changes.to_string(),
                    timestamp,
                ],
            )?;
        }
        get_task_columns(conn, &current.id)?
            .map(task_to_json)
            .ok_or_else(|| CommandError::new("DB_ERROR", "流转后读取任务失败"))
    })();

    match result {
        Ok(task) => {
            conn.execute_batch("COMMIT")?;
            Ok(task)
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

/// 更新任务属性：对齐 upstream updateTask（database.mjs:1803-1940）
/// 白名单 title/description/status/priority/labels/startDate/dueDate/assignee；
/// version 乐观并发；labels 变更后与项目标签库合并去重；status 变化置
/// sortOrder=min−1000；活动流只记实际变化字段（taskFieldChanges diff 语义）。
/// thread_id：Some 且与当前值不同 → 随写（CLI 会话归属）；None → 不动（挂件口径）。
/// actor：活动流记录者（挂件本地用户 / CLI agent）。
pub fn update_task(
    conn: &Connection,
    id: &str,
    version: i64,
    changes: &Value,
    thread_id: Option<&str>,
    actor: &Actor,
) -> Result<Value, CommandError> {
    let Some(changes_obj) = changes.as_object() else {
        return Err(CommandError::new("INVALID_FIELD", "changes 必须是对象"));
    };
    // 白名单校验（未知键拒绝，对齐上游；assignee 为 CLI 扩展）
    const WHITELIST: [&str; 8] = [
        "title", "description", "status", "priority", "labels", "startDate", "dueDate", "assignee",
    ];
    for key in changes_obj.keys() {
        if !WHITELIST.contains(&key.as_str()) {
            return Err(CommandError::new("INVALID_FIELD", format!("不支持更新的字段：{key}")));
        }
    }
    let current = get_task_columns(conn, id)?
        .ok_or_else(|| CommandError::new("TASK_NOT_FOUND", format!("任务不存在：{id}")))?;
    if current.version != version {
        return Err(CommandError::new("VERSION_CONFLICT", "任务已被其他会话修改，请重试"));
    }
    if current.archived_at.is_some() {
        return Err(CommandError::new("TASK_ARCHIVED", "已归档任务不能编辑"));
    }

    // —— 计算实际变化（活动流 diff；未变化字段跳过 UPDATE）——
    let mut set_clauses: Vec<String> = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    let mut activity_changes: Vec<Value> = Vec::new();
    let mut new_labels: Option<Vec<String>> = None;
    let mut new_status: Option<String> = None;
    let mut assignee_before: Option<String> = None;

    let push = |clauses: &mut Vec<String>, params: &mut Vec<Box<dyn rusqlite::ToSql>>, clause: String, value: Box<dyn rusqlite::ToSql>| {
        clauses.push(clause);
        params.push(value);
    };

    for (key, after) in changes_obj {
        let changed = match key.as_str() {
            "title" => {
                let Some(t) = after.as_str() else {
                    return Err(CommandError::new("INVALID_FIELD", "title 必须是字符串"));
                };
                if t.trim().is_empty() || t.chars().count() > 240 {
                    return Err(CommandError::new("INVALID_FIELD", "标题必填且不超过 240 字"));
                }
                let differs = t != current.title;
                if differs {
                    push(&mut set_clauses, &mut params, "title = ?".into(), Box::new(t.to_string()));
                }
                differs
            }
            "description" => {
                let Some(d) = after.as_str() else {
                    return Err(CommandError::new("INVALID_FIELD", "description 必须是字符串"));
                };
                let differs = d != current.description;
                if differs {
                    push(&mut set_clauses, &mut params, "description = ?".into(), Box::new(d.to_string()));
                }
                differs
            }
            "status" => {
                let Some(s) = after.as_str() else {
                    return Err(CommandError::new("INVALID_FIELD", "status 必须是字符串"));
                };
                if !TASK_STATUSES.contains(&s) {
                    return Err(CommandError::new("INVALID_FIELD", format!("非法 status：{s}")));
                }
                let differs = s != current.status;
                if differs {
                    new_status = Some(s.to_string());
                }
                differs
            }
            "priority" => {
                let Some(p) = after.as_str() else {
                    return Err(CommandError::new("INVALID_FIELD", "priority 必须是字符串"));
                };
                if !TASK_PRIORITIES.contains(&p) {
                    return Err(CommandError::new("INVALID_FIELD", format!("非法 priority：{p}")));
                }
                let differs = p != current.priority;
                if differs {
                    push(&mut set_clauses, &mut params, "priority = ?".into(), Box::new(p.to_string()));
                }
                differs
            }
            "labels" => {
                let Some(arr) = after.as_array() else {
                    return Err(CommandError::new("INVALID_FIELD", "labels 必须是数组"));
                };
                let labels: Vec<String> = arr
                    .iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect();
                let current_labels: Vec<String> =
                    serde_json::from_str(&current.labels).unwrap_or_default();
                if serde_json::to_string(&labels).ok() == serde_json::to_string(&current_labels).ok() {
                    false
                } else {
                    new_labels = Some(labels);
                    true
                }
            }
            "startDate" => {
                let s = after.as_str().map(String::from);
                let differs = s != current.start_date;
                if differs {
                    push(&mut set_clauses, &mut params, "start_date = ?".into(), Box::new(s));
                }
                differs
            }
            "dueDate" => {
                let d = after.as_str().map(String::from);
                let differs = d != current.due_date;
                if differs {
                    push(&mut set_clauses, &mut params, "due_date = ?".into(), Box::new(d));
                }
                differs
            }
            // CLI 扩展（--assignee <id>）：agent actor 以 id 落 assignee 三列
            "assignee" => {
                let Some(a) = after.as_str() else {
                    return Err(CommandError::new("INVALID_FIELD", "assignee 必须是字符串"));
                };
                let before: Option<String> = conn.query_row(
                    "SELECT assignee_id FROM tasks WHERE id = ?1",
                    rusqlite::params![current.id],
                    |row| row.get(0),
                )?;
                assignee_before = before.clone();
                let differs = before.as_deref() != Some(a);
                if differs {
                    push(&mut set_clauses, &mut params, "assignee_type = ?".into(), Box::new("agent".to_string()));
                    push(&mut set_clauses, &mut params, "assignee_id = ?".into(), Box::new(a.to_string()));
                    push(&mut set_clauses, &mut params, "assignee_name = ?".into(), Box::new(a.to_string()));
                }
                differs
            }
            _ => unreachable!("白名单已过滤"),
        };
        if changed {
            let (field_name, before_value) = if key == "assignee" {
                ("assigneeId", assignee_before.clone().map(Value::String).unwrap_or(Value::Null))
            } else {
                (key.as_str(), field_before(&current, key))
            };
            activity_changes.push(json!({
                "field": field_name,
                "before": before_value,
                "after": after,
            }));
        }
    }

    // status 变化 → sort_order = 目标状态 min − 1000（对齐上游）
    if let Some(status) = &new_status {
        let minimum: Option<f64> = conn.query_row(
            "SELECT MIN(sort_order) FROM tasks
             WHERE project_id = ?1 AND status = ?2 AND archived_at IS NULL AND id != ?3",
            rusqlite::params![current.project_id, status, current.id],
            |row| row.get(0),
        )?;
        let sort_order = minimum.map_or(1000.0, |min| min - 1000.0);
        push(&mut set_clauses, &mut params, "status = ?".into(), Box::new(status.clone()));
        push(&mut set_clauses, &mut params, "sort_order = ?".into(), Box::new(sort_order));
    }

    // 会话归属：Some 且与当前不同 → 随写（对齐 Node updateTask；不记活动流 diff）
    if let Some(t) = thread_id {
        if current.thread_id.as_deref() != Some(t) {
            push(&mut set_clauses, &mut params, "thread_id = ?".into(), Box::new(t.to_string()));
        }
    }

    // 无任何实际变化 → 直接返回当前（不产生 version 递增，对齐上游 diff 语义）
    if set_clauses.is_empty() && new_labels.is_none() {
        return get_task_columns(conn, &current.id)?
            .map(task_to_json)
            .ok_or_else(|| CommandError::new("DB_ERROR", "更新后读取任务失败"));
    }

    // labels 变更 → 与项目标签库合并去重回写（对齐上游 1925-1932）
    if let Some(labels) = &new_labels {
        let project_labels: String = conn.query_row(
            "SELECT labels FROM projects WHERE id = ?1",
            rusqlite::params![current.project_id],
            |row| row.get(0),
        )?;
        let mut catalog: Vec<String> = serde_json::from_str(&project_labels).unwrap_or_default();
        for label in labels {
            if !catalog.contains(label) {
                catalog.push(label.clone());
            }
        }
        let catalog_json = serde_json::to_string(&catalog)
            .map_err(|e| CommandError::new("DB_ERROR", format!("序列化标签库失败：{e}")))?;
        conn.execute(
            "UPDATE projects SET labels = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![catalog_json, now_iso(), current.project_id],
        )?;
        let labels_json = serde_json::to_string(labels)
            .map_err(|e| CommandError::new("DB_ERROR", format!("序列化标签失败：{e}")))?;
        push(&mut set_clauses, &mut params, "labels = ?".into(), Box::new(labels_json));
    }

    let timestamp = now_iso();
    push(&mut set_clauses, &mut params, "updated_at = ?".into(), Box::new(timestamp.clone()));

    let sql = format!(
        "UPDATE tasks SET {}, version = version + 1 WHERE id = ? AND version = ?",
        set_clauses.join(", ")
    );
    // 参数顺序：set 值 → id → version（version 自增不占参数位）
    let mut param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    param_refs.push(&current.id);
    param_refs.push(&version);

    conn.execute_batch("BEGIN IMMEDIATE")?;
    let result = (|| -> Result<Value, CommandError> {
        let updated = conn.execute(&sql, param_refs.as_slice())?;
        if updated != 1 {
            return Err(CommandError::new("VERSION_CONFLICT", "任务已被其他会话修改，请重试"));
        }
        if !activity_changes.is_empty() {
            conn.execute(
                "INSERT INTO task_activities (
                   id, task_id, actor_type, actor_id, actor_name, actor_avatar_url, changes, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                rusqlite::params![
                    uuid::Uuid::new_v4().to_string(),
                    current.id,
                    actor.kind,
                    actor.id,
                    actor.name,
                    actor.avatar_url,
                    serde_json::to_string(&activity_changes)
                        .unwrap_or_else(|_| "[]".into()),
                    timestamp,
                ],
            )?;
        }
        get_task_columns(conn, &current.id)?
            .map(task_to_json)
            .ok_or_else(|| CommandError::new("DB_ERROR", "更新后读取任务失败"))
    })();

    match result {
        Ok(task) => {
            conn.execute_batch("COMMIT")?;
            Ok(task)
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

/// 活动流 diff 的 before 值（与 update_task 白名单一致）
fn field_before(t: &TaskColumns, field: &str) -> Value {
    match field {
        "title" => json!(t.title),
        "description" => json!(t.description),
        "status" => json!(t.status),
        "priority" => json!(t.priority),
        "labels" => serde_json::from_str(&t.labels).unwrap_or(json!([])),
        "startDate" => json!(t.start_date),
        "dueDate" => json!(t.due_date),
        _ => Value::Null,
    }
}

/// 任务详情：task 全字段 + 评论 + 活动流，一次返回（L3-本机「详情+评论」数据源）。
/// activities 一并返回（数据顺手），UI 暂只渲染详情+评论，活动流留给后续迭代。
pub fn issue_detail(conn: &Connection, id: &str) -> Result<Value, CommandError> {
    let task = get_task_columns(conn, id)?
        .ok_or_else(|| CommandError::new("TASK_NOT_FOUND", format!("任务不存在：{id}")))?;

    // 详情补充字段：描述 + 创建/负责人（列表子集之外的深看信息）
    let detail: (String, String, String, String, String) = conn.query_row(
        "SELECT description, creator_type, creator_name, assignee_type, assignee_name
         FROM tasks WHERE id = ?1",
        rusqlite::params![task.id],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        },
    )?;
    let (description, creator_type, creator_name, assignee_type, assignee_name) = detail;

    // 评论：upstream listComments 按 (created_at, id) 排序，但 id 是随机 UUID——
    // 同毫秒连发时顺序不定（widget 表单与 taskctl 都可能触发）。tiebreaker 改
    // rowid（插入序=时间序，确定性），仅此处有意偏离上游。
    let mut comments: Vec<Value> = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT id, body, author_type, author_name, version, created_at
         FROM comments WHERE task_id = ?1 ORDER BY created_at, rowid",
    )?;
    let rows = stmt.query_map(rusqlite::params![task.id], |row| {
        Ok(json!({
            "id": row.get::<_, String>(0)?,
            "body": row.get::<_, String>(1)?,
            "authorType": row.get::<_, String>(2)?,
            "authorName": row.get::<_, String>(3)?,
            "version": row.get::<_, i64>(4)?,
            "createdAt": row.get::<_, String>(5)?,
        }))
    })?;
    for row in rows {
        comments.push(row?);
    }

    // 活动流：同上，tiebreaker 用 rowid 保证同毫秒事件的稳定顺序
    let mut activities: Vec<Value> = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT actor_type, actor_name, changes, created_at
         FROM task_activities WHERE task_id = ?1 ORDER BY created_at, rowid",
    )?;
    let rows = stmt.query_map(rusqlite::params![task.id], |row| {
        Ok(json!({
            "actorType": row.get::<_, String>(0)?,
            "actorName": row.get::<_, String>(1)?,
            "changes": row.get::<_, String>(2)?,
            "createdAt": row.get::<_, String>(3)?,
        }))
    })?;
    for row in rows {
        activities.push(row?);
    }

    let mut task_json = task_to_json(task);
    task_json["description"] = Value::String(description);
    task_json["creatorType"] = Value::String(creator_type);
    task_json["creatorName"] = Value::String(creator_name);
    task_json["assigneeType"] = Value::String(assignee_type);
    task_json["assigneeName"] = Value::String(assignee_name);
    // 全版看板扩展：关联视图 + 附件元数据
    let relations = relations_of(conn, &task_json["id"].as_str().unwrap_or_default());
    let attachments = attachments_of(conn, &task_json["id"].as_str().unwrap_or_default());
    Ok(json!({ "task": task_json, "comments": comments, "activities": activities, "relations": relations, "attachments": attachments }))
}

/// 发表评论：对齐 upstream createComment（database.mjs:2207）——
/// INSERT version=1、不写活动流；归属 WIDGET_THREAD_ID + 本地用户 actor。
pub fn add_comment(conn: &Connection, task_id: &str, body: &str) -> Result<Value, CommandError> {
    // 校验：任务存在（同上游 #requireTask）+ body 非空
    let task = get_task_columns(conn, task_id)?
        .ok_or_else(|| CommandError::new("TASK_NOT_FOUND", format!("任务不存在：{task_id}")))?;
    if body.trim().is_empty() {
        return Err(CommandError::new("INVALID_FIELD", "评论内容不能为空"));
    }

    let id = uuid::Uuid::new_v4().to_string();
    let timestamp = now_iso();
    let (author_type, author_id, author_name) = LOCAL_USER_ACTOR;
    conn.execute(
        "INSERT INTO comments (
           id, task_id, body, thread_id, thread_codex_project_id, thread_codex_project_kind,
           thread_codex_host_id, thread_workspace_path,
           author_type, author_id, author_name, author_avatar_url,
           version, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, NULL, NULL, NULL, NULL, ?5, ?6, ?7, NULL, 1, ?8, ?8)",
        rusqlite::params![id, task.id, body.trim(), WIDGET_THREAD_ID, author_type, author_id, author_name, timestamp],
    )?;

    Ok(json!({
        "id": id,
        "body": body.trim(),
        "authorType": author_type,
        "authorName": author_name,
        "version": 1,
        "createdAt": timestamp,
    }))
}

/// 标签库新增：对齐 upstream addProjectLabel（database.mjs:1216）
pub fn add_project_label(conn: &Connection, project_id: &str, label: &str) -> Result<Value, CommandError> {
    let label = label.trim();
    if label.is_empty() || label.chars().count() > 64 {
        return Err(CommandError::new("INVALID_FIELD", "标签必填且不超过 64 字"));
    }
    let labels_json: String = conn
        .query_row("SELECT labels FROM projects WHERE id = ?1", rusqlite::params![project_id], |r| r.get(0))
        .map_err(|_| CommandError::new("PROJECT_NOT_FOUND", format!("项目不存在：{project_id}")))?;
    let mut labels: Vec<String> = serde_json::from_str(&labels_json).unwrap_or_default();
    if !labels.iter().any(|l| l == label) {
        labels.push(label.to_string());
        conn.execute(
            "UPDATE projects SET labels = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![serde_json::to_string(&labels).unwrap(), now_iso(), project_id],
        )?;
    }
    Ok(json!({ "ok": true, "labels": labels }))
}

/// 标签库删除：对齐 upstream deleteProjectLabel（database.mjs:1230）——
/// 删标签库条目并从该项目所有任务的 labels 中移除该标签（version+1）
pub fn delete_project_label(conn: &Connection, project_id: &str, label: &str) -> Result<Value, CommandError> {
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let result = (|| -> Result<Value, CommandError> {
        let labels_json: String = conn
            .query_row("SELECT labels FROM projects WHERE id = ?1", rusqlite::params![project_id], |r| r.get(0))
            .map_err(|_| CommandError::new("PROJECT_NOT_FOUND", format!("项目不存在：{project_id}")))?;
        let labels: Vec<String> = serde_json::from_str(&labels_json).unwrap_or_default();
        let timestamp = now_iso();
        if labels.iter().any(|l| l == label) {
            let remaining: Vec<&String> = labels.iter().filter(|l| *l != label).collect();
            conn.execute(
                "UPDATE projects SET labels = ?1, updated_at = ?2 WHERE id = ?3",
                rusqlite::params![serde_json::to_string(&remaining).unwrap(), timestamp, project_id],
            )?;
        }
        // 从任务 labels 中移除（对齐上游：逐任务 version+1）
        let mut stmt = conn.prepare("SELECT id, labels FROM tasks WHERE project_id = ?1")?;
        let rows: Vec<(String, String)> = stmt
            .query_map(rusqlite::params![project_id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .filter_map(|r| r.ok())
            .collect();
        drop(stmt);
        for (task_id, task_labels_json) in rows {
            let task_labels: Vec<String> = serde_json::from_str(&task_labels_json).unwrap_or_default();
            if task_labels.iter().any(|l| l == label) {
                let remaining: Vec<&String> = task_labels.iter().filter(|l| *l != label).collect();
                conn.execute(
                    "UPDATE tasks SET labels = ?1, version = version + 1, updated_at = ?2 WHERE id = ?3",
                    rusqlite::params![serde_json::to_string(&remaining).unwrap(), timestamp, task_id],
                )?;
            }
        }
        Ok(json!({ "ok": true }))
    })();
    match result {
        Ok(v) => {
            conn.execute_batch("COMMIT")?;
            Ok(v)
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

/// 归档任务：对齐 upstream archiveTask（database.mjs:1994）；actor 记活动流
pub fn archive_task(conn: &Connection, id: &str, version: i64, actor: &Actor) -> Result<Value, CommandError> {
    let current = get_task_columns(conn, id)?
        .ok_or_else(|| CommandError::new("TASK_NOT_FOUND", format!("任务不存在：{id}")))?;
    if current.version != version {
        return Err(CommandError::new("VERSION_CONFLICT", "任务已被其他会话修改，请重试"));
    }
    let timestamp = now_iso();
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let result = (|| -> Result<Value, CommandError> {
        let updated = conn.execute(
            "UPDATE tasks SET archived_at = ?1, version = version + 1, updated_at = ?1 WHERE id = ?2 AND version = ?3",
            rusqlite::params![timestamp, current.id, version],
        )?;
        if updated != 1 {
            return Err(CommandError::new("VERSION_CONFLICT", "任务已被其他会话修改，请重试"));
        }
        let (actor_type, actor_id, actor_name) = (actor.kind.as_str(), actor.id.as_str(), actor.name.as_str());
        conn.execute(
            "INSERT INTO task_activities (
               id, task_id, actor_type, actor_id, actor_name, actor_avatar_url, changes, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                uuid::Uuid::new_v4().to_string(),
                current.id,
                actor_type, actor_id, actor_name,
                actor.avatar_url,
                json!([{ "field": "archivedAt", "before": current.archived_at, "after": timestamp }]).to_string(),
                timestamp,
            ],
        )?;
        get_task_columns(conn, &current.id)?.map(task_to_json)
            .ok_or_else(|| CommandError::new("DB_ERROR", "归档后读取任务失败"))
    })();
    match result {
        Ok(task) => { conn.execute_batch("COMMIT")?; Ok(task) }
        Err(e) => { let _ = conn.execute_batch("ROLLBACK"); Err(e) }
    }
}

/// 恢复归档：对齐 upstream restoreTask（database.mjs:2029）——仅归档任务可恢复；actor 记活动流
pub fn restore_task(conn: &Connection, id: &str, version: i64, actor: &Actor) -> Result<Value, CommandError> {
    let current = get_task_columns(conn, id)?
        .ok_or_else(|| CommandError::new("TASK_NOT_FOUND", format!("任务不存在：{id}")))?;
    if current.version != version {
        return Err(CommandError::new("VERSION_CONFLICT", "任务已被其他会话修改，请重试"));
    }
    if current.archived_at.is_none() {
        return Err(CommandError::new("TASK_NOT_ARCHIVED", "只有已归档任务可以恢复"));
    }
    let timestamp = now_iso();
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let result = (|| -> Result<Value, CommandError> {
        let updated = conn.execute(
            "UPDATE tasks SET archived_at = NULL, version = version + 1, updated_at = ?1 WHERE id = ?2 AND version = ?3",
            rusqlite::params![timestamp, current.id, version],
        )?;
        if updated != 1 {
            return Err(CommandError::new("VERSION_CONFLICT", "任务已被其他会话修改，请重试"));
        }
        let (actor_type, actor_id, actor_name) = (actor.kind.as_str(), actor.id.as_str(), actor.name.as_str());
        conn.execute(
            "INSERT INTO task_activities (
               id, task_id, actor_type, actor_id, actor_name, actor_avatar_url, changes, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                uuid::Uuid::new_v4().to_string(),
                current.id,
                actor_type, actor_id, actor_name,
                actor.avatar_url,
                json!([{ "field": "archivedAt", "before": current.archived_at, "after": null }]).to_string(),
                timestamp,
            ],
        )?;
        get_task_columns(conn, &current.id)?.map(task_to_json)
            .ok_or_else(|| CommandError::new("DB_ERROR", "恢复后读取任务失败"))
    })();
    match result {
        Ok(task) => { conn.execute_batch("COMMIT")?; Ok(task) }
        Err(e) => { let _ = conn.execute_batch("ROLLBACK"); Err(e) }
    }
}

/// 删除已归档任务：对齐 upstream deleteArchivedTask（database.mjs:2063）——
/// 仅归档可删（TASK_NOT_ARCHIVED）；级联删评论/活动/关联 + 磁盘附件清理
/// 返回被删除的附件 id 列表（调用方负责 emit 后的清理确认）。
pub fn delete_task(conn: &Connection, id: &str, version: i64) -> Result<Value, CommandError> {
    let current = get_task_columns(conn, id)?
        .ok_or_else(|| CommandError::new("TASK_NOT_FOUND", format!("任务不存在：{id}")))?;
    if current.version != version {
        return Err(CommandError::new("VERSION_CONFLICT", "任务已被其他会话修改，请重试"));
    }
    if current.archived_at.is_none() {
        return Err(CommandError::new("TASK_NOT_ARCHIVED", "只有已归档任务可以删除"));
    }
    // 附件 id 先行收集（行删除后无从查起），磁盘文件在事务成功后清理
    let mut attachment_ids: Vec<String> = Vec::new();
    {
        let mut stmt = conn.prepare("SELECT id FROM attachments WHERE task_id = ?1")?;
        let rows = stmt.query_map(rusqlite::params![current.id], |r| r.get::<_, String>(0))?;
        for row in rows {
            attachment_ids.push(row?);
        }
    }
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let result = (|| -> Result<(), CommandError> {
        // ON DELETE CASCADE 覆盖 comments/task_activities/attachments/task_relations
        let deleted = conn.execute("DELETE FROM tasks WHERE id = ?1 AND version = ?2",
            rusqlite::params![current.id, version])?;
        if deleted != 1 {
            return Err(CommandError::new("VERSION_CONFLICT", "任务已被其他会话修改，请重试"));
        }
        Ok(())
    })();
    match result {
        Ok(()) => {
            conn.execute_batch("COMMIT")?;
            // 磁盘附件清理（ENOENT 容忍——上游同语义）
            if let Some(data_dir) = std::env::var("VIBE_TASKDECK_DATA_DIR").ok().filter(|s| !s.trim().is_empty())
                .or_else(|| std::env::var("APPDATA").ok()) {
                let base = if std::env::var("VIBE_TASKDECK_DATA_DIR").ok().filter(|s| !s.trim().is_empty()).is_some() {
                    std::path::PathBuf::from(data_dir)
                } else {
                    std::path::PathBuf::from(data_dir).join("Vibe-TaskDeck")
                };
                for attachment_id in &attachment_ids {
                    if let Some(safe) = sanitize_attachment_id(attachment_id) {
                        let _ = std::fs::remove_file(base.join("attachments").join(safe));
                    }
                }
            }
            Ok(json!({ "ok": true, "deletedAttachmentIds": attachment_ids }))
        }
        Err(e) => { let _ = conn.execute_batch("ROLLBACK"); Err(e) }
    }
}

/// 附件 id 安全校验：UUID 格式（构造性免疫路径穿越；返回规范路径段）。
/// pub(crate) 级：taskctl.rs 下载入口按同口径校验 operand（对齐 Node isAttachmentId）
pub fn sanitize_attachment_id(id: &str) -> Option<&str> {
    let ok = id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
        && !id.contains("..");
    if ok { Some(id) } else { None }
}

/// 关联端点规范化：对齐 upstream #relationEndpoints——
/// parent: (parent, source=related, target=task)；blocks: (blocks, task→related)；
/// blocked_by: (blocks, related→task)；related: 字典序 (source<target)
fn relation_endpoints(kind: &str, task_id: &str, related_id: &str) -> Result<(&'static str, String, String), CommandError> {
    match kind {
        "parent" => Ok(("parent", related_id.to_string(), task_id.to_string())),
        "blocks" => Ok(("blocks", task_id.to_string(), related_id.to_string())),
        "blocked_by" => Ok(("blocks", related_id.to_string(), task_id.to_string())),
        "related" => {
            let (a, b) = if task_id < related_id { (task_id, related_id) } else { (related_id, task_id) };
            Ok(("related", a.to_string(), b.to_string()))
        }
        _ => Err(CommandError::new("INVALID_FIELD", format!("非法关联类型：{kind}"))),
    }
}

fn relation_brief(conn: &Connection, task_id: &str) -> Option<Value> {
    let (identifier, title): (String, String) = conn
        .query_row("SELECT identifier, title FROM tasks WHERE id = ?1", rusqlite::params![task_id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .ok()?;
    Some(json!({ "id": task_id, "identifier": identifier, "title": title }))
}

/// 添加关联：对齐 upstream addTaskRelation（parent 替换已有父 + 环检测；重复报 RELATION_EXISTS）
/// 活动流记录 relation 类型变化；version 乐观并发 touch 双方。
pub fn add_relation(
    conn: &Connection,
    id: &str,
    version: i64,
    kind: &str,
    related_id: &str,
) -> Result<Value, CommandError> {
    if id == related_id {
        return Err(CommandError::new("INVALID_FIELD", "不能与自身建立关联"));
    }
    let task = get_task_columns(conn, id)?
        .ok_or_else(|| CommandError::new("TASK_NOT_FOUND", format!("任务不存在：{id}")))?;
    let related = get_task_columns(conn, related_id)?
        .ok_or_else(|| CommandError::new("TASK_NOT_FOUND", format!("任务不存在：{related_id}")))?;
    if task.version != version {
        return Err(CommandError::new("VERSION_CONFLICT", "任务已被其他会话修改，请重试"));
    }
    let (relation_type, source_id, target_id) = relation_endpoints(kind, id, related_id)?;

    // parent 环检测：related 的祖先链不得包含 task（child→parent 向上）
    if relation_type == "parent" {
        let mut cursor = related.id.clone();
        for _ in 0..100 {
            let parent: Option<String> = conn
                .query_row(
                    "SELECT source_task_id FROM task_relations WHERE relation_type = 'parent' AND target_task_id = ?1",
                    rusqlite::params![cursor],
                    |r| r.get(0),
                )
                .map(Some)
                .or_else(|e| match e {
                    rusqlite::Error::QueryReturnedNoRows => Ok(None),
                    e => Err(e),
                })?;
            match parent {
                Some(p) if p == task.id => {
                    return Err(CommandError::new("INVALID_FIELD", "不能创建循环的父子关联"));
                }
                Some(p) => cursor = p,
                None => break,
            }
        }
    }

    conn.execute_batch("BEGIN IMMEDIATE")?;
    let result = (|| -> Result<(), CommandError> {
        let timestamp = now_iso();
        if relation_type == "parent" {
            // 单父约束：替换已有 parent（对齐上游）
            conn.execute(
                "DELETE FROM task_relations WHERE relation_type = 'parent' AND target_task_id = ?1",
                rusqlite::params![target_id],
            )?;
        } else {
            let exists: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM task_relations WHERE relation_type = ?1 AND source_task_id = ?2 AND target_task_id = ?3)",
                    rusqlite::params![relation_type, source_id, target_id],
                    |r| r.get(0),
                )?;
            if exists {
                return Err(CommandError::new("RELATION_EXISTS", "该关联已存在"));
            }
        }
        conn.execute(
            "INSERT INTO task_relations (relation_type, source_task_id, target_task_id, created_at) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![relation_type, source_id, target_id, timestamp],
        )?;
        // touch 双方（对齐上游 #touchTask）
        for tid in [&task.id, &related.id] {
            conn.execute(
                "UPDATE tasks SET version = version + 1, updated_at = ?1 WHERE id = ?2",
                rusqlite::params![timestamp, tid],
            )?;
        }
        Ok(())
    })();
    match result {
        Ok(()) => { conn.execute_batch("COMMIT")?; Ok(json!({ "ok": true })) }
        Err(e) => { let _ = conn.execute_batch("ROLLBACK"); Err(e) }
    }
}

/// 移除关联：端点规范化同上；不存在报 RELATION_NOT_FOUND
pub fn remove_relation(
    conn: &Connection,
    id: &str,
    version: i64,
    kind: &str,
    related_id: &str,
) -> Result<Value, CommandError> {
    let task = get_task_columns(conn, id)?
        .ok_or_else(|| CommandError::new("TASK_NOT_FOUND", format!("任务不存在：{id}")))?;
    if task.version != version {
        return Err(CommandError::new("VERSION_CONFLICT", "任务已被其他会话修改，请重试"));
    }
    let (relation_type, source_id, target_id) = relation_endpoints(kind, id, related_id)?;
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let result = (|| -> Result<(), CommandError> {
        let deleted = conn.execute(
            "DELETE FROM task_relations WHERE relation_type = ?1 AND source_task_id = ?2 AND target_task_id = ?3",
            rusqlite::params![relation_type, source_id, target_id],
        )?;
        if deleted == 0 {
            return Err(CommandError::new("RELATION_NOT_FOUND", "该关联不存在"));
        }
        let timestamp = now_iso();
        conn.execute(
            "UPDATE tasks SET version = version + 1, updated_at = ?1 WHERE id = ?2",
            rusqlite::params![timestamp, id],
        )?;
        Ok(())
    })();
    match result {
        Ok(()) => { conn.execute_batch("COMMIT")?; Ok(json!({ "ok": true })) }
        Err(e) => { let _ = conn.execute_batch("ROLLBACK"); Err(e) }
    }
}

/// 任务的关联视图（issue_detail 补充）：parent 单个 + blocks/blockedBy/related 列表
pub fn relations_of(conn: &Connection, id: &str) -> Value {
    let mut parent: Vec<Value> = Vec::new();
    let mut blocks: Vec<Value> = Vec::new();
    let mut blocked_by: Vec<Value> = Vec::new();
    let mut related: Vec<Value> = Vec::new();
    // 出边：parent(我是子) / blocks(我阻塞它) / related
    if let Ok(mut stmt) = conn.prepare(
        "SELECT relation_type, target_task_id FROM task_relations WHERE source_task_id = ?1",
    ) {
        if let Ok(rows) = stmt.query_map(rusqlite::params![id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        }) {
            for row in rows.flatten() {
                let (kind, other) = row;
                let brief = relation_brief(conn, &other);
                match kind.as_str() {
                    "parent" => { if let Some(b) = brief { parent.push(b); } }
                    "blocks" => { if let Some(b) = brief { blocks.push(b); } }
                    "related" => { if let Some(b) = brief { related.push(b); } }
                    _ => {}
                }
            }
        }
    }
    // 入边：parent(我是父) 不在此展示（在对方的 parent 里）；blocks 入边 = blockedBy
    if let Ok(mut stmt) = conn.prepare(
        "SELECT relation_type, source_task_id FROM task_relations WHERE target_task_id = ?1 AND relation_type = 'blocks'",
    ) {
        if let Ok(rows) = stmt.query_map(rusqlite::params![id], |r| r.get::<_, String>(1)) {
            for row in rows.flatten() {
                if let Some(b) = relation_brief(conn, &row) { blocked_by.push(b); }
            }
        }
    }
    // 入边 related（对方建的 related 也算）
    if let Ok(mut stmt) = conn.prepare(
        "SELECT source_task_id FROM task_relations WHERE target_task_id = ?1 AND relation_type = 'related'",
    ) {
        if let Ok(rows) = stmt.query_map(rusqlite::params![id], |r| r.get::<_, String>(0)) {
            for row in rows.flatten() {
                if let Some(b) = relation_brief(conn, &row) { related.push(b); }
            }
        }
    }
    json!({ "parent": parent, "blocks": blocks, "blockedBy": blocked_by, "related": related })
}

/// 附件目录（与上游同位：<数据目录>/attachments；构造性安全——只存 UUID 文件名）。
/// pub(crate) 级：taskctl.rs 的附件上传/下载共用同一目录（挂件/CLI 同根互通）
pub fn attachments_dir() -> Option<std::path::PathBuf> {
    let data_dir = std::env::var("VIBE_TASKDECK_DATA_DIR")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var("APPDATA")
                .ok()
                .map(|d| std::path::PathBuf::from(d).join("Vibe-TaskDeck"))
        })?;
    Some(data_dir.join("attachments"))
}

/// 上传附件：元数据入库 + 内容写磁盘（文件名 = UUID，对齐上游）
pub fn upload_attachment(
    conn: &Connection,
    task_id: &str,
    comment_id: Option<&str>,
    filename: &str,
    content_type: &str,
    base64_data: &str,
) -> Result<Value, CommandError> {
    let task = get_task_columns(conn, task_id)?
        .ok_or_else(|| CommandError::new("TASK_NOT_FOUND", format!("任务不存在：{task_id}")))?;
    if filename.is_empty() || filename.len() > 255 {
        return Err(CommandError::new("INVALID_FIELD", "文件名非法"));
    }
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data)
        .map_err(|_| CommandError::new("INVALID_FIELD", "base64 解码失败"))?;
    if bytes.len() > 10 * 1024 * 1024 {
        return Err(CommandError::new("ATTACHMENT_TOO_LARGE", "附件不能超过 10MB"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let timestamp = now_iso();
    let dir = attachments_dir()
        .ok_or_else(|| CommandError::new("DB_ERROR", "无法定位附件目录"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| CommandError::new("DB_ERROR", format!("创建附件目录失败：{e}")))?;
    std::fs::write(dir.join(&id), &bytes)
        .map_err(|e| CommandError::new("DB_ERROR", format!("写入附件失败：{e}")))?;
    conn.execute(
        "INSERT INTO attachments (id, task_id, comment_id, filename, content_type, size, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![id, task.id, comment_id, filename, content_type, bytes.len() as i64, timestamp],
    )?;
    Ok(json!({ "id": id, "filename": filename, "contentType": content_type, "size": bytes.len(), "createdAt": timestamp }))
}

/// 读取附件内容（base64 返回）；id 校验 UUID 免路径穿越
pub fn read_attachment(conn: &Connection, id: &str) -> Result<Value, CommandError> {
    let safe = sanitize_attachment_id(id)
        .ok_or_else(|| CommandError::new("INVALID_FIELD", "附件 id 非法"))?;
    let (task_id, filename, content_type): (String, String, String) = conn.query_row(
        "SELECT task_id, filename, content_type FROM attachments WHERE id = ?1",
        rusqlite::params![safe],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .map_err(|_| CommandError::new("ATTACHMENT_NOT_FOUND", format!("附件不存在：{safe}")))?;
    let dir = attachments_dir().ok_or_else(|| CommandError::new("DB_ERROR", "无法定位附件目录"))?;
    let bytes = std::fs::read(dir.join(safe))
        .map_err(|_| CommandError::new("ATTACHMENT_NOT_FOUND", "附件文件缺失"))?;
    use base64::Engine;
    Ok(json!({
        "id": safe, "taskId": task_id, "filename": filename,
        "contentType": content_type, "base64": base64::engine::general_purpose::STANDARD.encode(bytes),
    }))
}

/// 删除附件（DB 行 + 磁盘文件；ENOENT 容忍）
pub fn delete_attachment(conn: &Connection, id: &str) -> Result<Value, CommandError> {
    let safe = sanitize_attachment_id(id)
        .ok_or_else(|| CommandError::new("INVALID_FIELD", "附件 id 非法"))?;
    let deleted = conn.execute("DELETE FROM attachments WHERE id = ?1", rusqlite::params![safe])?;
    if deleted == 0 {
        return Err(CommandError::new("ATTACHMENT_NOT_FOUND", format!("附件不存在：{safe}")));
    }
    if let Some(dir) = attachments_dir() {
        let _ = std::fs::remove_file(dir.join(safe));
    }
    Ok(json!({ "ok": true }))
}

/// 任务的附件元数据列表（issue_detail 补充）
pub fn attachments_of(conn: &Connection, task_id: &str) -> Vec<Value> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT id, filename, content_type, size, created_at FROM attachments WHERE task_id = ?1 ORDER BY created_at, id",
    ) else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map(rusqlite::params![task_id], |r| {
        Ok(json!({
            "id": r.get::<_, String>(0)?,
            "filename": r.get::<_, String>(1)?,
            "contentType": r.get::<_, String>(2)?,
            "size": r.get::<_, i64>(3)?,
            "createdAt": r.get::<_, String>(4)?,
        }))
    }) else {
        return Vec::new();
    };
    rows.filter_map(|r| r.ok()).collect()
}

/* ============================================================
 * CLI 口径（taskctl.rs 专用）——评论/附件簇。
 *
 * 与 cli/database.mjs 的同名方法逐字对齐：错误码/消息（英文）、输出形状
 * （Node #commentJson / createAttachment）。与上面挂件 GUI 函数
 * （add_comment / upload_attachment 等）互不影响——GUI 归属本地用户 +
 * WIDGET_THREAD_ID，CLI 归属 AI actor + 显式 thread_id；老函数挂件在用不动。
 * 评论增删改不写活动流（对齐 Node createComment「不写活动流」与上游）。
 * ============================================================ */

/// CLI 评论全字段行（输出形状对齐 Node #commentJson）
struct CommentRow {
    id: String,
    task_id: String,
    body: String,
    thread_id: Option<String>,
    author_type: String,
    author_id: String,
    author_name: String,
    author_avatar_url: Option<String>,
    version: i64,
    created_at: String,
    updated_at: String,
}

fn comment_row(conn: &Connection, id: &str) -> rusqlite::Result<Option<CommentRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, task_id, body, thread_id, author_type, author_id, author_name,
                author_avatar_url, version, created_at, updated_at
         FROM comments WHERE id = ?1",
    )?;
    let mut rows = stmt.query_map(rusqlite::params![id], |row| {
        Ok(CommentRow {
            id: row.get(0)?,
            task_id: row.get(1)?,
            body: row.get(2)?,
            thread_id: row.get(3)?,
            author_type: row.get(4)?,
            author_id: row.get(5)?,
            author_name: row.get(6)?,
            author_avatar_url: row.get(7)?,
            version: row.get(8)?,
            created_at: row.get(9)?,
            updated_at: row.get(10)?,
        })
    })?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

fn comment_to_json(c: &CommentRow) -> Value {
    json!({
        "id": c.id,
        "taskId": c.task_id,
        "body": c.body,
        "threadId": c.thread_id,
        "authorType": c.author_type,
        "authorId": c.author_id,
        "authorName": c.author_name,
        "authorAvatarUrl": c.author_avatar_url,
        "version": c.version,
        "createdAt": c.created_at,
        "updatedAt": c.updated_at,
    })
}

/// 任务定位（CLI 附件前置校验等）：id 或 identifier 均可（对齐 Node #taskRow）
pub fn task_id_cli(conn: &Connection, id: &str) -> Option<String> {
    get_task_columns(conn, id).ok().flatten().map(|t| t.id)
}

/// 评论列表（CLI 口径）：ORDER BY created_at, rowid——tiebreaker 对齐本文件
/// issue_detail 与 Node listComments 的确定性偏离（同毫秒连发顺序稳定）
pub fn list_comments_cli(conn: &Connection, task_id: &str) -> Result<Vec<Value>, CommandError> {
    let owner = task_id_cli(conn, task_id)
        .ok_or_else(|| CommandError::new("TASK_NOT_FOUND", format!("Task '{task_id}' does not exist")))?;
    let mut stmt = conn.prepare(
        "SELECT id, task_id, body, thread_id, author_type, author_id, author_name,
                author_avatar_url, version, created_at, updated_at
         FROM comments WHERE task_id = ?1 ORDER BY created_at, rowid",
    )?;
    let rows = stmt.query_map(rusqlite::params![owner], |row| {
        Ok(CommentRow {
            id: row.get(0)?,
            task_id: row.get(1)?,
            body: row.get(2)?,
            thread_id: row.get(3)?,
            author_type: row.get(4)?,
            author_id: row.get(5)?,
            author_name: row.get(6)?,
            author_avatar_url: row.get(7)?,
            version: row.get(8)?,
            created_at: row.get(9)?,
            updated_at: row.get(10)?,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).map(|c| comment_to_json(&c)).collect())
}

/// 发表评论（CLI 口径）：actor 参数化（AI agent）+ thread_id 显式归属；
/// body trim 非空校验；不写活动流（对齐 Node createComment）
pub fn create_comment_cli(
    conn: &Connection,
    task_id: &str,
    body: &str,
    thread_id: &str,
    actor: (&str, &str, &str),
) -> Result<Value, CommandError> {
    let owner = task_id_cli(conn, task_id)
        .ok_or_else(|| CommandError::new("TASK_NOT_FOUND", format!("Task '{task_id}' does not exist")))?;
    if body.trim().is_empty() {
        return Err(CommandError::new("INVALID_FIELD", "'body' cannot be empty"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let timestamp = now_iso();
    conn.execute(
        "INSERT INTO comments (
           id, task_id, body, thread_id, thread_codex_project_id, thread_codex_project_kind,
           thread_codex_host_id, thread_workspace_path,
           author_type, author_id, author_name, author_avatar_url,
           version, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, NULL, NULL, NULL, NULL, ?5, ?6, ?7, NULL, 1, ?8, ?8)",
        rusqlite::params![id, owner, body.trim(), thread_id, actor.0, actor.1, actor.2, timestamp],
    )?;
    comment_row(conn, &id)?
        .as_ref()
        .map(comment_to_json)
        .ok_or_else(|| CommandError::new("DB_ERROR", "创建后读取评论失败"))
}

/// 更新评论（CLI 口径）：乐观锁（version 不匹配 → VERSION_CONFLICT）；
/// body trim 非空；thread_id 随写覆盖（CLI 强制显式）
pub fn update_comment_cli(
    conn: &Connection,
    comment_id: &str,
    version: i64,
    body: &str,
    thread_id: &str,
) -> Result<Value, CommandError> {
    let current = comment_row(conn, comment_id)?
        .ok_or_else(|| CommandError::new("COMMENT_NOT_FOUND", format!("Comment '{comment_id}' does not exist")))?;
    if body.trim().is_empty() {
        return Err(CommandError::new("INVALID_FIELD", "'body' cannot be empty"));
    }
    let timestamp = now_iso();
    let updated = conn.execute(
        "UPDATE comments SET body = ?1, thread_id = ?2, version = version + 1, updated_at = ?3
         WHERE id = ?4 AND version = ?5",
        rusqlite::params![body.trim(), thread_id, timestamp, current.id, version],
    )?;
    if updated != 1 {
        return Err(CommandError::new(
            "VERSION_CONFLICT",
            "Task was modified by another session; reload and retry with the current version",
        ));
    }
    comment_row(conn, &current.id)?
        .as_ref()
        .map(comment_to_json)
        .ok_or_else(|| CommandError::new("DB_ERROR", "更新后读取评论失败"))
}

/// 删除评论（CLI 口径）：乐观锁；不存在 COMMENT_NOT_FOUND
pub fn delete_comment_cli(conn: &Connection, comment_id: &str, version: i64) -> Result<(), CommandError> {
    let current = comment_row(conn, comment_id)?
        .ok_or_else(|| CommandError::new("COMMENT_NOT_FOUND", format!("Comment '{comment_id}' does not exist")))?;
    let deleted = conn.execute(
        "DELETE FROM comments WHERE id = ?1 AND version = ?2",
        rusqlite::params![current.id, version],
    )?;
    if deleted != 1 {
        return Err(CommandError::new(
            "VERSION_CONFLICT",
            "Task was modified by another session; reload and retry with the current version",
        ));
    }
    Ok(())
}

/// 评论定位（attachment upload --comment 前置校验）：不存在返回 None
pub fn get_comment_cli(conn: &Connection, comment_id: &str) -> Option<Value> {
    comment_row(conn, comment_id).ok().flatten().as_ref().map(comment_to_json)
}

/// 附件元数据入库（CLI 口径，对齐 Node createAttachment：--comment 时
/// task_id 从评论行派生；filename 非空 ≤255；磁盘文件由 CLI 层先行写好）
pub fn create_attachment_cli(
    conn: &Connection,
    id: &str,
    task_id: Option<&str>,
    comment_id: Option<&str>,
    filename: &str,
    content_type: &str,
    size: i64,
) -> Result<Value, CommandError> {
    if filename.is_empty() || filename.chars().count() > 255 {
        return Err(CommandError::new(
            "INVALID_FIELD",
            "'filename' must be a non-empty string of at most 255 characters",
        ));
    }
    if size < 0 {
        return Err(CommandError::new("INVALID_FIELD", "'size' must be a non-negative integer"));
    }
    let (owner_task_id, owner_comment_id) = match comment_id {
        Some(cid) => {
            let comment = comment_row(conn, cid)?
                .ok_or_else(|| CommandError::new("COMMENT_NOT_FOUND", format!("Comment '{cid}' does not exist")))?;
            (comment.task_id, Some(comment.id))
        }
        None => {
            let tid = task_id.unwrap_or_default();
            let owner = task_id_cli(conn, tid)
                .ok_or_else(|| CommandError::new("TASK_NOT_FOUND", format!("Task '{tid}' does not exist")))?;
            (owner, None)
        }
    };
    let timestamp = now_iso();
    conn.execute(
        "INSERT INTO attachments (id, task_id, comment_id, filename, content_type, size, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![id, owner_task_id, owner_comment_id, filename, content_type, size, timestamp],
    )?;
    Ok(json!({
        "id": id,
        "filename": filename,
        "contentType": content_type,
        "size": size,
        "createdAt": timestamp,
    }))
}

/// 附件元数据查询（CLI 口径；磁盘文件是否在由 CLI 层核查）
pub fn get_attachment_cli(conn: &Connection, id: &str) -> Option<Value> {
    conn.query_row(
        "SELECT id, task_id, comment_id, filename, content_type, size, created_at
         FROM attachments WHERE id = ?1",
        rusqlite::params![id],
        |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "taskId": row.get::<_, String>(1)?,
                "commentId": row.get::<_, Option<String>>(2)?,
                "filename": row.get::<_, String>(3)?,
                "contentType": row.get::<_, String>(4)?,
                "size": row.get::<_, i64>(5)?,
                "createdAt": row.get::<_, String>(6)?,
            }))
        },
    )
    .ok()
}

/// 项目 id → identifier 前缀（对齐 upstream projectPrefix：大写、剔非字母数字、截 12）
fn project_prefix(project_id: &str) -> String {
    let prefix: String = project_id
        .to_uppercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    let prefix = if prefix.is_empty() { "TASK".to_string() } else { prefix };
    prefix.chars().take(12).collect()
}

/* ============================================================
 * CLI（taskctl）口径扩展：宽形状序列化 + 全量查询/写入
 *
 * 输出契约逐字对齐 cli/taskctl-local.mjs / cli/database.mjs：
 *   · task 27 字段宽形状（#taskJson）：snake_case → camelCase、null 处理一致
 *   · issue get = 宽 task + comments + activities（#getTask）
 *   · activity feed 跨任务聚合（#listActivityFeed：rowid 游标 + thread 过滤）
 *   · project 宽形状（#projectJson）与 create（PROJECT_EXISTS 409）
 * 挂件 GUI 依赖的窄形状函数（list_tasks/task_to_json/issue_detail）不动。
 * ============================================================ */

/// CLI 全量任务列（对齐 Node TASK_SELECT_COLUMNS）
const TASK_FULL_COLUMNS: &str = "id, identifier, project_id, title, description, status, priority, labels, sort_order,
       thread_id, creator_type, creator_id, creator_name, creator_avatar_url,
       assignee_type, assignee_id, assignee_name, assignee_avatar_url,
       workflow_id, git_branch, worktree_path, worktree_branch,
       start_date, due_date, recurrence_interval, recurrence_unit,
       archived_at, version, created_at, updated_at";

#[derive(Debug)]
struct TaskFullRow {
    id: String,
    identifier: String,
    project_id: String,
    title: String,
    description: String,
    status: String,
    priority: String,
    labels: String,
    sort_order: f64,
    thread_id: Option<String>,
    creator_type: String,
    creator_id: String,
    creator_name: String,
    creator_avatar_url: Option<String>,
    assignee_type: String,
    assignee_id: String,
    assignee_name: String,
    assignee_avatar_url: Option<String>,
    workflow_id: Option<String>,
    git_branch: Option<String>,
    worktree_path: Option<String>,
    worktree_branch: Option<String>,
    start_date: Option<String>,
    due_date: Option<String>,
    recurrence_interval: Option<i64>,
    recurrence_unit: Option<String>,
    archived_at: Option<String>,
    version: i64,
    created_at: String,
    updated_at: String,
}

fn read_task_full_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TaskFullRow> {
    Ok(TaskFullRow {
        id: row.get(0)?,
        identifier: row.get(1)?,
        project_id: row.get(2)?,
        title: row.get(3)?,
        description: row.get(4)?,
        status: row.get(5)?,
        priority: row.get(6)?,
        labels: row.get(7)?,
        sort_order: row.get(8)?,
        thread_id: row.get(9)?,
        creator_type: row.get(10)?,
        creator_id: row.get(11)?,
        creator_name: row.get(12)?,
        creator_avatar_url: row.get(13)?,
        assignee_type: row.get(14)?,
        assignee_id: row.get(15)?,
        assignee_name: row.get(16)?,
        assignee_avatar_url: row.get(17)?,
        workflow_id: row.get(18)?,
        git_branch: row.get(19)?,
        worktree_path: row.get(20)?,
        worktree_branch: row.get(21)?,
        start_date: row.get(22)?,
        due_date: row.get(23)?,
        recurrence_interval: row.get(24)?,
        recurrence_unit: row.get(25)?,
        archived_at: row.get(26)?,
        version: row.get(27)?,
        created_at: row.get(28)?,
        updated_at: row.get(29)?,
    })
}

/// CLI 宽形状 task（27 字段；对齐 Node #taskJson 的键与 null 语义）
fn task_full_json(t: &TaskFullRow) -> Value {
    json!({
        "id": t.id,
        "identifier": t.identifier,
        "projectId": t.project_id,
        "title": t.title,
        "description": t.description,
        "status": t.status,
        "priority": t.priority,
        "labels": parse_json_value(&t.labels),
        "sortOrder": t.sort_order,
        "threadId": t.thread_id,
        "creatorType": t.creator_type,
        "creatorId": t.creator_id,
        "creatorName": t.creator_name,
        "creatorAvatarUrl": t.creator_avatar_url,
        "assigneeType": t.assignee_type,
        "assigneeId": t.assignee_id,
        "assigneeName": t.assignee_name,
        "assigneeAvatarUrl": t.assignee_avatar_url,
        "workflowId": t.workflow_id,
        "developmentContext": development_context_json(t),
        "recurrence": match t.recurrence_interval {
            Some(interval) => json!({ "interval": interval, "unit": t.recurrence_unit }),
            None => Value::Null,
        },
        "startDate": t.start_date,
        "dueDate": t.due_date,
        "archivedAt": t.archived_at,
        "version": t.version,
        "createdAt": t.created_at,
        "updatedAt": t.updated_at,
    })
}

/// developmentContext（对齐 Node #developmentContext：branch > worktree > null）
fn development_context_json(t: &TaskFullRow) -> Value {
    if let Some(branch) = &t.git_branch {
        return json!({ "type": "branch", "branch": branch });
    }
    if let Some(path) = &t.worktree_path {
        return json!({ "type": "worktree", "path": path, "branch": t.worktree_branch });
    }
    Value::Null
}

/// JSON 数组列容错解析（对齐 Node #parseJsonArray：非数组/解析失败 → []）
fn parse_json_value(text: &str) -> Value {
    match serde_json::from_str::<Value>(text) {
        Ok(value) if value.is_array() => value,
        _ => json!([]),
    }
}

/// 按 id/identifier 取宽形状 task（对齐 Node #taskRow 的定位规则）
pub fn get_task_wide(conn: &Connection, id: &str) -> Option<Value> {
    let sql = format!("SELECT {TASK_FULL_COLUMNS} FROM tasks WHERE id = ?1 OR identifier = ?1");
    let mut stmt = conn.prepare(&sql).ok()?;
    let mut rows = stmt.query_map(rusqlite::params![id], read_task_full_row).ok()?;
    rows.next()?.ok().map(|t| task_full_json(&t))
}

/// 按真实 id 取宽形状 task（内部复用）
fn task_wide_by_id(conn: &Connection, id: &str) -> rusqlite::Result<Option<Value>> {
    let sql = format!("SELECT {TASK_FULL_COLUMNS} FROM tasks WHERE id = ?1");
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query_map(rusqlite::params![id], read_task_full_row)?;
    match rows.next() {
        Some(row) => Ok(Some(task_full_json(&row?))),
        None => Ok(None),
    }
}

/// issue get：宽形状 task + comments + activities（对齐 Node #getTask）。
/// 评论/活动排序 tiebreaker 用 rowid（插入序=时间序，同挂件 issue_detail）。
pub fn get_task_full(conn: &Connection, id: &str) -> Option<Value> {
    let mut task = get_task_wide(conn, id)?;
    let task_id = task["id"].as_str()?.to_string();
    task["comments"] = json!(task_comments_full(conn, &task_id));
    task["activities"] = json!(task_activities_full(conn, &task_id));
    Some(task)
}

/// 评论宽形状列表（对齐 Node #commentJson 全字段）
fn task_comments_full(conn: &Connection, task_id: &str) -> Vec<Value> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT id, task_id, body, thread_id, author_type, author_id, author_name,
                author_avatar_url, version, created_at, updated_at
         FROM comments WHERE task_id = ?1 ORDER BY created_at, rowid",
    ) else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map(rusqlite::params![task_id], |row| {
        Ok(json!({
            "id": row.get::<_, String>(0)?,
            "taskId": row.get::<_, String>(1)?,
            "body": row.get::<_, String>(2)?,
            "threadId": row.get::<_, Option<String>>(3)?,
            "authorType": row.get::<_, String>(4)?,
            "authorId": row.get::<_, String>(5)?,
            "authorName": row.get::<_, String>(6)?,
            "authorAvatarUrl": row.get::<_, Option<String>>(7)?,
            "version": row.get::<_, i64>(8)?,
            "createdAt": row.get::<_, String>(9)?,
            "updatedAt": row.get::<_, String>(10)?,
        }))
    }) else {
        return Vec::new();
    };
    rows.filter_map(|r| r.ok()).collect()
}

/// 活动流宽形状列表（对齐 Node #activityJson：changes 解析为数组）
fn task_activities_full(conn: &Connection, task_id: &str) -> Vec<Value> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT id, task_id, actor_type, actor_id, actor_name, actor_avatar_url, changes, created_at
         FROM task_activities WHERE task_id = ?1 ORDER BY created_at, rowid",
    ) else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map(rusqlite::params![task_id], |row| {
        Ok(activity_json(
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, String>(6)?,
            row.get::<_, String>(7)?,
        ))
    }) else {
        return Vec::new();
    };
    rows.filter_map(|r| r.ok()).collect()
}

fn activity_json(
    id: String,
    task_id: String,
    actor_type: String,
    actor_id: String,
    actor_name: String,
    actor_avatar_url: Option<String>,
    changes: String,
    created_at: String,
) -> Value {
    let changes: Value = match serde_json::from_str::<Value>(&changes) {
        Ok(value) if value.is_array() => value,
        _ => json!([]),
    };
    json!({
        "id": id,
        "taskId": task_id,
        "actorType": actor_type,
        "actorId": actor_id,
        "actorName": actor_name,
        "actorAvatarUrl": actor_avatar_url,
        "changes": changes,
        "createdAt": created_at,
    })
}

/// 任务定位 + 当前版本（taskctl resolveVersion / relation 解析复用）：
/// 返回 (真实 id, version)；不存在返回 None（支持 identifier）
pub fn task_version(conn: &Connection, id: &str) -> Option<(String, i64)> {
    conn.query_row(
        "SELECT id, version FROM tasks WHERE id = ?1 OR identifier = ?1",
        rusqlite::params![id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
    )
    .ok()
}

/// id/identifier → 真实 uuid（不存在返回 None）
pub fn resolve_task_id(conn: &Connection, id: &str) -> Option<String> {
    task_version(conn, id).map(|(real, _)| real)
}

/// issue list 过滤器（project/status/priority/assignee/creator/label/thread-id/
/// archived/search；archived None = all 不按归档过滤，默认语义由调用方归一化）
#[derive(Clone, Copy)]
pub struct TaskListFilter<'a> {
    pub project_id: Option<&'a str>,
    pub status: Option<&'a str>,
    pub priority: Option<&'a str>,
    pub assignee_id: Option<&'a str>,
    pub creator_id: Option<&'a str>,
    pub label: Option<&'a str>,
    pub thread_id: Option<&'a str>,
    /// Some(true) 只看归档 / Some(false) 只看未归档 / None 不过滤
    pub archived: Option<bool>,
    pub search: Option<&'a str>,
}

/// LIKE 通配符转义（%/_/\ 前缀反斜杠，配合 ESCAPE '\'）
fn escape_like(value: &str) -> String {
    value.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

/// CLI 口径任务列表（宽形状 + 过滤；ORDER BY 对齐 db.rs #list_tasks / Node listTasks）
pub fn list_tasks_full(conn: &Connection, filter: &TaskListFilter) -> Vec<Value> {
    let mut clauses: Vec<String> = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if let Some(v) = filter.project_id.filter(|s| !s.is_empty()) {
        clauses.push("project_id = ?".into());
        params.push(Box::new(v.to_string()));
    }
    if let Some(v) = filter.status.filter(|s| !s.is_empty()) {
        clauses.push("status = ?".into());
        params.push(Box::new(v.to_string()));
    }
    if let Some(v) = filter.priority.filter(|s| !s.is_empty()) {
        clauses.push("priority = ?".into());
        params.push(Box::new(v.to_string()));
    }
    if let Some(v) = filter.assignee_id.filter(|s| !s.is_empty()) {
        clauses.push("assignee_id = ?".into());
        params.push(Box::new(v.to_string()));
    }
    if let Some(v) = filter.creator_id.filter(|s| !s.is_empty()) {
        clauses.push("creator_id = ?".into());
        params.push(Box::new(v.to_string()));
    }
    if let Some(v) = filter.thread_id.filter(|s| !s.is_empty()) {
        clauses.push("thread_id = ?".into());
        params.push(Box::new(v.to_string()));
    }
    if let Some(label) = filter.label.filter(|s| !s.is_empty()) {
        // labels 是 JSON 数组列：按 JSON 字符串形式的元素精确匹配（"label" 带引号）
        clauses.push("labels LIKE ? ESCAPE '\\'".into());
        let quoted = serde_json::to_string(label).unwrap_or_default();
        params.push(Box::new(format!("%{}%", escape_like(&quoted))));
    }
    if let Some(v) = filter.search.filter(|s| !s.is_empty()) {
        clauses.push("title LIKE ? ESCAPE '\\'".into());
        params.push(Box::new(format!("%{}%", escape_like(v))));
    }
    match filter.archived {
        Some(true) => clauses.push("archived_at IS NOT NULL".into()),
        Some(false) => clauses.push("archived_at IS NULL".into()),
        None => {}
    }
    let where_sql = if clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", clauses.join(" AND "))
    };
    let sql = format!(
        "SELECT {TASK_FULL_COLUMNS} FROM tasks
         {where_sql}
         ORDER BY
           CASE status
             WHEN 'backlog' THEN 1
             WHEN 'todo' THEN 2
             WHEN 'in_progress' THEN 3
             WHEN 'in_review' THEN 4
             WHEN 'blocked' THEN 5
             WHEN 'done' THEN 6
             WHEN 'canceled' THEN 7
           END,
           sort_order, created_at, id"
    );
    let Ok(mut stmt) = conn.prepare(&sql) else {
        return Vec::new();
    };
    let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let Ok(rows) = stmt.query_map(param_refs.as_slice(), read_task_full_row) else {
        return Vec::new();
    };
    rows.filter_map(|r| r.ok()).map(|t| task_full_json(&t)).collect()
}

/// 项目宽形状（对齐 Node #projectJson：id/name/workspacePath/labels/createdAt/updatedAt）
fn project_full_json(id: String, name: String, workspace_path: Option<String>, labels: String, created_at: String, updated_at: String) -> Value {
    json!({
        "id": id,
        "name": name,
        "workspacePath": workspace_path,
        "labels": parse_json_value(&labels),
        "createdAt": created_at,
        "updatedAt": updated_at,
    })
}

/// CLI 项目列表（宽形状；ORDER BY 对齐 Node listProjects）
pub fn list_projects_full(conn: &Connection) -> Vec<Value> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT id, name, workspace_path, labels, created_at, updated_at FROM projects ORDER BY created_at, id",
    ) else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map([], |row| {
        Ok(project_full_json(
            row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?,
        ))
    }) else {
        return Vec::new();
    };
    rows.filter_map(|r| r.ok()).collect()
}

/// 新建项目（对齐 Node createProject：PROJECT_EXISTS 409；labels 默认标签库）
pub fn create_project(conn: &Connection, id: &str, name: &str, workspace_path: Option<&str>) -> Result<Value, CommandError> {
    let exists: bool = conn
        .query_row("SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)", rusqlite::params![id], |r| r.get(0))
        .unwrap_or(false);
    if exists {
        return Err(CommandError::new("PROJECT_EXISTS", format!("Project '{id}' already exists")));
    }
    let timestamp = now_iso();
    conn.execute(
        "INSERT INTO projects (id, name, workspace_path, labels, next_task_number, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6)",
        rusqlite::params![id, name, workspace_path, DEFAULT_PROJECT_LABELS_JSON, timestamp, timestamp],
    )?;
    conn.query_row(
        "SELECT id, name, workspace_path, labels, created_at, updated_at FROM projects WHERE id = ?1",
        rusqlite::params![id],
        |row| {
            Ok(project_full_json(
                row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?,
            ))
        },
    )
    .map_err(|e| CommandError::new("DB_ERROR", format!("创建项目后读取失败：{e}")))
}

/// 项目存在性（taskctl issue create 前置校验）
pub fn project_exists(conn: &Connection, id: &str) -> bool {
    conn.query_row("SELECT id FROM projects WHERE id = ?1", rusqlite::params![id], |_| Ok(()))
        .is_ok()
}

/// 活动流聚合读取（taskctl activity list；对齐 Node #listActivityFeed）：
/// thread_id 圈定会话名下任务（含人机双方变更）；缺省跨全部任务。
/// since_id 为全局游标——只返回该活动之后（rowid 更大）的记录；未知游标视为无游标。
/// 附带 taskIdentifier/taskTitle 便于跨任务定位。
pub fn list_activity_feed(conn: &Connection, thread_id: Option<&str>, since_id: Option<&str>) -> Vec<Value> {
    let mut clauses: Vec<String> = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if let Some(t) = thread_id.filter(|s| !s.is_empty()) {
        clauses.push("t.thread_id = ?".into());
        params.push(Box::new(t.to_string()));
    }
    if let Some(s) = since_id.filter(|s| !s.is_empty()) {
        clauses.push("a.rowid > COALESCE((SELECT rowid FROM task_activities WHERE id = ?), -1)".into());
        params.push(Box::new(s.to_string()));
    }
    let where_sql = if clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", clauses.join(" AND "))
    };
    let sql = format!(
        "SELECT a.id, a.task_id, a.actor_type, a.actor_id, a.actor_name, a.actor_avatar_url,
                a.changes, a.created_at, t.identifier, t.title
         FROM task_activities a
         JOIN tasks t ON t.id = a.task_id
         {where_sql}
         ORDER BY a.created_at, a.rowid"
    );
    let Ok(mut stmt) = conn.prepare(&sql) else {
        return Vec::new();
    };
    let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let Ok(rows) = stmt.query_map(param_refs.as_slice(), |row| {
        let mut activity = activity_json(
            row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?,
            row.get(5)?, row.get(6)?, row.get(7)?,
        );
        activity["taskIdentifier"] = json!(row.get::<_, String>(8)?);
        activity["taskTitle"] = json!(row.get::<_, String>(9)?);
        Ok(activity)
    }) else {
        return Vec::new();
    };
    rows.filter_map(|r| r.ok()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        migrate(&conn).unwrap();
        seed_local_project(&conn).unwrap();
        conn
    }

    #[test]
    fn create_task_writes_local_user_and_widget_thread() {
        let conn = test_db();
        let task = create_task(&conn, "测试任务", "backlog", "high", Some("2026-12-31"), &local_user_actor()).unwrap();
        assert_eq!(task["identifier"], "LOCAL-1");
        assert_eq!(task["status"], "backlog");
        assert_eq!(task["priority"], "high");
        assert_eq!(task["dueDate"], "2026-12-31");
        assert_eq!(task["version"], 1);
        assert_eq!(task["threadId"], "taskboard-widget");
        // creator/assignee 为本地用户（对齐 upstream 无头请求默认 actor）
        let row: (String, String, String, String, String) = conn
            .query_row(
                "SELECT creator_type, creator_id, assignee_type, assignee_id, title FROM tasks WHERE id = ?1",
                rusqlite::params![task["id"].as_str().unwrap()],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(row.0, "user");
        assert_eq!(row.1, "local-user");
        assert_eq!(row.2, "user");
        assert_eq!(row.3, "local-user");
    }

    #[test]
    fn create_task_validates_fields() {
        let conn = test_db();
        assert_eq!(create_task(&conn, "", "backlog", "none", None, &local_user_actor()).unwrap_err().code, "INVALID_FIELD");
        assert_eq!(
            create_task(&conn, "标题", "bad_status", "none", None, &local_user_actor()).unwrap_err().code,
            "INVALID_FIELD"
        );
        assert_eq!(
            create_task(&conn, "标题", "backlog", "bad_priority", None, &local_user_actor()).unwrap_err().code,
            "INVALID_FIELD"
        );
    }

    #[test]
    /// 回归：list_tasks 必须带 creatorType——曾因缺字段导致挂件 L1/L2 的
    /// agent 徽标对真实数据不渲染（mock 数据自带字段掩盖了缺口）
    fn list_tasks_includes_creator_type() {
        let conn = test_db();
        create_task(&conn, "用户任务", "todo", "none", None, &local_user_actor()).unwrap();
        // 直接写入一条 agent 任务（对齐 taskctl 的 CODEX_AGENT_ACTOR 写入口径）
        conn.execute(
            "INSERT INTO tasks (id, identifier, project_id, title, description, status, priority,
             labels, sort_order, thread_id, creator_type, creator_id, creator_name,
             assignee_type, assignee_id, assignee_name, version, created_at, updated_at)
             VALUES ('ag-1', 'LOCAL-9', 'local', 'agent 任务', '', 'todo', 'none',
             '[]', 1000, 'th-test', 'agent', 'codex-agent', 'Codex Agent',
             'agent', 'codex-agent', 'Codex Agent', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
            [],
        )
        .unwrap();
        let tasks = list_tasks(&conn);
        let agent = tasks.iter().find(|t| t["title"] == "agent 任务").unwrap();
        assert_eq!(agent["creatorType"], "agent");
        let user = tasks.iter().find(|t| t["title"] == "用户任务").unwrap();
        assert_eq!(user["creatorType"], "user");
    }

    #[test]
    fn move_task_updates_status_version_and_activity() {
        let conn = test_db();
        let task = create_task(&conn, "流转任务", "todo", "none", None, &local_user_actor()).unwrap();
        let id = task["id"].as_str().unwrap().to_string();
        let moved = move_task(&conn, &id, 1, "in_progress", None, Some(WIDGET_THREAD_ID), &local_user_actor()).unwrap();
        assert_eq!(moved["status"], "in_progress");
        assert_eq!(moved["version"], 2);
        // 状态变化必须写活动流（Node 端 getTask 读取）
        let changes: String = conn
            .query_row(
                "SELECT changes FROM task_activities WHERE task_id = ?1",
                rusqlite::params![id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(changes.contains("\"field\":\"status\""));
        assert!(changes.contains("\"before\":\"todo\""));
        assert!(changes.contains("\"after\":\"in_progress\""));
    }

    #[test]
    fn move_task_rejects_stale_version() {
        let conn = test_db();
        let task = create_task(&conn, "冲突任务", "todo", "none", None, &local_user_actor()).unwrap();
        let id = task["id"].as_str().unwrap().to_string();
        move_task(&conn, &id, 1, "in_progress", None, Some(WIDGET_THREAD_ID), &local_user_actor()).unwrap();
        // 用过期 version 1 再次流转 → VERSION_CONFLICT
        let conflict = move_task(&conn, &id, 1, "done", None, Some(WIDGET_THREAD_ID), &local_user_actor()).unwrap_err();
        assert_eq!(conflict.code, "VERSION_CONFLICT");
        // 任务不存在
        assert_eq!(move_task(&conn, "no-such", 1, "done", None, Some(WIDGET_THREAD_ID), &local_user_actor()).unwrap_err().code, "TASK_NOT_FOUND");
    }

    #[test]
    fn issue_detail_returns_task_comments_and_activities() {
        let conn = test_db();
        let task = create_task(&conn, "详情任务", "todo", "high", None, &local_user_actor()).unwrap();
        let id = task["id"].as_str().unwrap().to_string();
        add_comment(&conn, &id, "第一条评论").unwrap();
        add_comment(&conn, &id, "第二条评论").unwrap();
        move_task(&conn, &id, 1, "in_progress", None, Some(WIDGET_THREAD_ID), &local_user_actor()).unwrap();

        let detail = issue_detail(&conn, &id).unwrap();
        assert_eq!(detail["task"]["title"], "详情任务");
        assert_eq!(detail["task"]["description"], "");
        assert_eq!(detail["task"]["creatorName"], "本地用户");
        assert_eq!(detail["task"]["assigneeName"], "本地用户");
        let comments = detail["comments"].as_array().unwrap();
        assert_eq!(comments.len(), 2);
        assert_eq!(comments[0]["body"], "第一条评论");
        assert_eq!(comments[0]["authorName"], "本地用户");
        assert_eq!(comments[0]["version"], 1);
        // 活动流：流转产生一条（评论不产生，对齐上游）
        let activities = detail["activities"].as_array().unwrap();
        assert_eq!(activities.len(), 1);
        assert!(activities[0]["changes"].as_str().unwrap().contains("in_progress"));
        // 按 identifier 也能查（与 move_task 同规则）
        assert!(issue_detail(&conn, "LOCAL-1").is_ok());
        assert_eq!(issue_detail(&conn, "no-such").unwrap_err().code, "TASK_NOT_FOUND");
    }

    #[test]
    fn add_comment_validates_and_trims() {
        let conn = test_db();
        let task = create_task(&conn, "评论任务", "todo", "none", None, &local_user_actor()).unwrap();
        let id = task["id"].as_str().unwrap().to_string();
        // 空评论拒绝（纯空白也拒绝）
        assert_eq!(add_comment(&conn, &id, "").unwrap_err().code, "INVALID_FIELD");
        assert_eq!(add_comment(&conn, &id, "   ").unwrap_err().code, "INVALID_FIELD");
        // 首尾空白被裁剪；thread 归属挂件会话
        let comment = add_comment(&conn, &id, "  内容  ").unwrap();
        assert_eq!(comment["body"], "内容");
        let thread_id: String = conn
            .query_row(
                "SELECT thread_id FROM comments WHERE id = ?1",
                rusqlite::params![comment["id"].as_str().unwrap()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(thread_id, "taskboard-widget");
        // 任务不存在
        assert_eq!(add_comment(&conn, "no-such", "x").unwrap_err().code, "TASK_NOT_FOUND");
    }

    #[test]
    fn archive_restore_delete_lifecycle() {
        let conn = test_db();
        let task = create_task(&conn, "归档生命周期", "todo", "none", None, &local_user_actor()).unwrap();
        let id = task["id"].as_str().unwrap().to_string();
        // 未归档：删除/恢复均拒绝（对齐上游）
        assert_eq!(delete_task(&conn, &id, 1).unwrap_err().code, "TASK_NOT_ARCHIVED");
        assert_eq!(restore_task(&conn, &id, 1, &local_user_actor()).unwrap_err().code, "TASK_NOT_ARCHIVED");
        // 归档 → archivedAt 非空 + version+1
        let archived = archive_task(&conn, &id, 1, &local_user_actor()).unwrap();
        assert!(archived["archivedAt"].as_str().is_some());
        // 重复归档（version 过期）→ 冲突
        assert_eq!(archive_task(&conn, &id, 1, &local_user_actor()).unwrap_err().code, "VERSION_CONFLICT");
        // 恢复成功
        let restored = restore_task(&conn, &id, 2, &local_user_actor()).unwrap();
        assert!(restored["archivedAt"].is_null());
        // 归档后删除成功
        archive_task(&conn, &id, 3, &local_user_actor()).unwrap();
        let deleted = delete_task(&conn, &id, 4).unwrap();
        assert_eq!(deleted["ok"], serde_json::json!(true));
        // 删除后不可再查
        assert_eq!(issue_detail(&conn, &id).unwrap_err().code, "TASK_NOT_FOUND");
    }

    #[test]
    fn project_label_crud_and_task_cleanup() {
        let conn = test_db();
        let task = create_task(&conn, "带标签", "todo", "none", None, &local_user_actor()).unwrap();
        let id = task["id"].as_str().unwrap().to_string();
        // update_task 加标签 → 项目标签库自动合并
        update_task(&conn, &id, 1, &serde_json::json!({ "labels": ["自定义"] }), None, &local_user_actor()).unwrap();
        let labels: String = conn.query_row("SELECT labels FROM projects WHERE id = 'local'", [], |r| r.get(0)).unwrap();
        assert!(labels.contains("自定义"));
        // 删除标签库条目 → 任务 labels 同步清除 + version+1
        delete_project_label(&conn, "local", "自定义").unwrap();
        let task_labels: String = conn.query_row("SELECT labels FROM tasks WHERE id = ?1", rusqlite::params![id], |r| r.get(0)).unwrap();
        assert!(!task_labels.contains("自定义"));
        let version: i64 = conn.query_row("SELECT version FROM tasks WHERE id = ?1", rusqlite::params![id], |r| r.get(0)).unwrap();
        assert_eq!(version, 3); // 1 → update+1 → label delete+1
        // 非法标签拒绝
        assert_eq!(add_project_label(&conn, "local", "").unwrap_err().code, "INVALID_FIELD");
    }

    #[test]
    fn attachment_id_sanitize_rejects_traversal() {
        assert!(sanitize_attachment_id("123e4567-e89b-12d3-a456-426614174000").is_some());
        assert!(sanitize_attachment_id("../etc/passwd").is_none());
        assert!(sanitize_attachment_id("..\\windows\\system32").is_none());
        assert!(sanitize_attachment_id("short").is_none());
        assert!(sanitize_attachment_id("123e4567e89b12d3a456426614174000Z").is_none()); // 长度对但含非法字符
    }

    #[test]
    fn relation_endpoints_and_constraints() {
        let conn = test_db();
        let a = create_task(&conn, "任务A", "todo", "none", None, &local_user_actor()).unwrap();
        let b = create_task(&conn, "任务B", "todo", "none", None, &local_user_actor()).unwrap();
        let a_id = a["id"].as_str().unwrap().to_string();
        let b_id = b["id"].as_str().unwrap().to_string();
        // parent：B 的父是 A
        add_relation(&conn, &a_id, 1, "parent", &b_id).unwrap();
        let rel = relations_of(&conn, &a_id);
        // A 是 B 的父 → A 的出边 parent=[B]（A 作为 source…wait parent 存储 source=parent）
        // 存储：relation_type=parent, source=B(父? no)
        void_rel(&rel);
        // 换个子视角：B 的 parent 应含 A
        let rel_b = relations_of(&conn, &b_id);
        assert_eq!(rel_b["parent"].as_array().unwrap().len(), 1);
        // A.parent=B 后再设 B.parent=A → 环检测拒绝
        let cycle_err = add_relation(&conn, &b_id, 2, "parent", &a_id).unwrap_err();
        assert_eq!(cycle_err.code, "INVALID_FIELD");
        // related 去重（source<target 规范化）；add_relation 双方 version+1：A/B 现为 v2
        let c = create_task(&conn, "任务C", "todo", "none", None, &local_user_actor()).unwrap();
        let c_id = c["id"].as_str().unwrap().to_string();
        add_relation(&conn, &a_id, 2, "related", &c_id).unwrap(); // A→v3, C→v2
        // 重复添加（反向）→ RELATION_EXISTS
        let err = add_relation(&conn, &c_id, 2, "related", &a_id).unwrap_err();
        assert_eq!(err.code, "RELATION_EXISTS");
        // 自我关联拒绝
        assert_eq!(add_relation(&conn, &a_id, 3, "related", &a_id).unwrap_err().code, "INVALID_FIELD");
        // blocks / blocked_by
        add_relation(&conn, &a_id, 3, "blocks", &c_id).unwrap(); // A→v4, C→v3
        let rel_c = relations_of(&conn, &c_id);
        assert_eq!(rel_c["blockedBy"].as_array().unwrap().len(), 1);
        // 移除不存在
        assert_eq!(remove_relation(&conn, &b_id, 2, "related", &c_id).unwrap_err().code, "RELATION_NOT_FOUND");
        // 移除成功
        remove_relation(&conn, &a_id, 4, "blocks", &c_id).unwrap(); // A→v5
        let rel_c2 = relations_of(&conn, &c_id);
        assert_eq!(rel_c2["blockedBy"].as_array().unwrap().len(), 0);
    }

    fn void_rel(_v: &Value) {}

    #[test]
    fn attachment_roundtrip_and_traversal_guard() {
        // 附件目录依赖数据目录环境变量（测试 shell 可能无 APPDATA）
        let tmp = std::env::temp_dir().join(format!("tb-att-test-{}", uuid::Uuid::new_v4()));
        std::env::set_var("VIBE_TASKDECK_DATA_DIR", &tmp);
        let conn = test_db();
        let task = create_task(&conn, "带附件", "todo", "none", None, &local_user_actor()).unwrap();
        let id = task["id"].as_str().unwrap().to_string();
        use base64::Engine;
        let content = base64::engine::general_purpose::STANDARD.encode(b"hello attachment");
        let up = upload_attachment(&conn, &id, None, "a.txt", "text/plain", &content).unwrap();
        let att_id = up["id"].as_str().unwrap().to_string();
        // 读取往返
        let read = read_attachment(&conn, &att_id).unwrap();
        assert_eq!(read["filename"], "a.txt");
        assert_eq!(read["base64"], content);
        // issue_detail 含附件元数据
        let detail = issue_detail(&conn, &id).unwrap();
        assert_eq!(detail["attachments"].as_array().unwrap().len(), 1);
        // 路径穿越拒绝
        assert_eq!(read_attachment(&conn, "../etc/passwd").unwrap_err().code, "INVALID_FIELD");
        // 删除后不可读
        delete_attachment(&conn, &att_id).unwrap();
        assert_eq!(read_attachment(&conn, &att_id).unwrap_err().code, "ATTACHMENT_NOT_FOUND");
    }

    /* ==== CLI 口径（comment/attachment 簇）：actor 参数化 / 乐观锁 / 契约形状 ==== */

    const CLI_ACTOR: (&str, &str, &str) = ("agent", "codex-agent", "Codex Agent");

    #[test]
    fn create_comment_cli_actor_thread_and_shape() {
        let conn = test_db();
        let task = create_task(&conn, "CLI 评论任务", "todo", "none", None, &local_user_actor()).unwrap();
        let id = task["id"].as_str().unwrap().to_string();
        // actor 参数化：agent 身份 + 显式 thread_id + 全字段输出形状
        let comment = create_comment_cli(&conn, &id, "  CLI 评论  ", "th-cli", CLI_ACTOR).unwrap();
        assert_eq!(comment["body"], "CLI 评论");
        assert_eq!(comment["taskId"], id);
        assert_eq!(comment["threadId"], "th-cli");
        assert_eq!(comment["authorType"], "agent");
        assert_eq!(comment["authorId"], "codex-agent");
        assert_eq!(comment["authorName"], "Codex Agent");
        assert_eq!(comment["authorAvatarUrl"], Value::Null);
        assert_eq!(comment["version"], 1);
        assert!(comment["createdAt"].as_str().is_some());
        assert!(comment["updatedAt"].as_str().is_some());
        // 空/纯空白 body 拒绝；任务不存在；identifier 寻址可用
        assert_eq!(create_comment_cli(&conn, &id, "   ", "t", CLI_ACTOR).unwrap_err().code, "INVALID_FIELD");
        assert_eq!(create_comment_cli(&conn, "no-such", "x", "t", CLI_ACTOR).unwrap_err().code, "TASK_NOT_FOUND");
        assert!(create_comment_cli(&conn, "LOCAL-1", "identifier 寻址", "t", CLI_ACTOR).is_ok());
    }

    #[test]
    fn list_comments_cli_orders_and_resolves_identifier() {
        let conn = test_db();
        let task = create_task(&conn, "列表任务", "todo", "none", None, &local_user_actor()).unwrap();
        let id = task["id"].as_str().unwrap().to_string();
        let first = create_comment_cli(&conn, &id, "第一条", "t", CLI_ACTOR).unwrap();
        let second = create_comment_cli(&conn, &id, "第二条", "t", CLI_ACTOR).unwrap();
        // 按 identifier 寻址列出，rowid tiebreaker 保证插入序
        let comments = list_comments_cli(&conn, "LOCAL-1").unwrap();
        assert_eq!(comments.len(), 2);
        assert_eq!(comments[0]["id"], first["id"]);
        assert_eq!(comments[1]["id"], second["id"]);
        // 每条都是全字段形状（含 threadId/authorId/authorAvatarUrl）
        assert_eq!(comments[0]["threadId"], "t");
        assert_eq!(comments[0]["authorId"], "codex-agent");
        assert_eq!(comments[0]["authorAvatarUrl"], Value::Null);
        assert_eq!(list_comments_cli(&conn, "no-such").unwrap_err().code, "TASK_NOT_FOUND");
    }

    #[test]
    fn update_and_delete_comment_cli_optimistic_lock() {
        let conn = test_db();
        let task = create_task(&conn, "乐观锁任务", "todo", "none", None, &local_user_actor()).unwrap();
        let id = task["id"].as_str().unwrap().to_string();
        let comment = create_comment_cli(&conn, &id, "原内容", "t1", CLI_ACTOR).unwrap();
        let cid = comment["id"].as_str().unwrap().to_string();
        // 更新：version 递增、body trim、thread_id 覆盖
        let updated = update_comment_cli(&conn, &cid, 1, "  新内容  ", "t2").unwrap();
        assert_eq!(updated["version"], 2);
        assert_eq!(updated["body"], "新内容");
        assert_eq!(updated["threadId"], "t2");
        // 过期 version → VERSION_CONFLICT；空 body 拒绝；评论不存在
        assert_eq!(update_comment_cli(&conn, &cid, 1, "x", "t").unwrap_err().code, "VERSION_CONFLICT");
        assert_eq!(update_comment_cli(&conn, &cid, 2, "  ", "t").unwrap_err().code, "INVALID_FIELD");
        assert_eq!(update_comment_cli(&conn, "no-such", 1, "x", "t").unwrap_err().code, "COMMENT_NOT_FOUND");
        // 删除：version 2 成功；再删（行已无）→ COMMENT_NOT_FOUND；过期 → VERSION_CONFLICT
        delete_comment_cli(&conn, &cid, 2).unwrap();
        assert_eq!(delete_comment_cli(&conn, &cid, 2).unwrap_err().code, "COMMENT_NOT_FOUND");
        let other = create_comment_cli(&conn, &id, "另一条", "t", CLI_ACTOR).unwrap();
        let oid = other["id"].as_str().unwrap().to_string();
        assert_eq!(delete_comment_cli(&conn, &oid, 9).unwrap_err().code, "VERSION_CONFLICT");
    }

    #[test]
    fn create_attachment_cli_derives_task_from_comment() {
        let conn = test_db();
        let task = create_task(&conn, "附件任务", "todo", "none", None, &local_user_actor()).unwrap();
        let id = task["id"].as_str().unwrap().to_string();
        let comment = create_comment_cli(&conn, &id, "带附件的评论", "t", CLI_ACTOR).unwrap();
        let cid = comment["id"].as_str().unwrap().to_string();
        let uuid = uuid::Uuid::new_v4().to_string();
        // --comment：task_id 从评论行派生 + comment_id 落库
        let by_comment = create_attachment_cli(&conn, &uuid, None, Some(&cid), "a.txt", "text/plain", 3).unwrap();
        assert_eq!(by_comment["id"], uuid);
        assert_eq!(by_comment["filename"], "a.txt");
        assert_eq!(by_comment["contentType"], "text/plain");
        assert_eq!(by_comment["size"], 3);
        let stored = get_attachment_cli(&conn, &uuid).unwrap();
        assert_eq!(stored["taskId"], id);
        assert_eq!(stored["commentId"], cid);
        // --task（identifier 寻址）：comment_id 为 null
        let uuid2 = uuid::Uuid::new_v4().to_string();
        create_attachment_cli(&conn, &uuid2, Some("LOCAL-1"), None, "b.png", "image/png", 0).unwrap();
        let stored2 = get_attachment_cli(&conn, &uuid2).unwrap();
        assert_eq!(stored2["taskId"], id);
        assert_eq!(stored2["commentId"], Value::Null);
        // 校验：filename 空/超 255；评论/任务不存在
        assert_eq!(create_attachment_cli(&conn, &uuid, Some(&id), None, "", "t", 1).unwrap_err().code, "INVALID_FIELD");
        assert_eq!(
            create_attachment_cli(&conn, &uuid, Some(&id), None, &"x".repeat(256), "t", 1).unwrap_err().code,
            "INVALID_FIELD"
        );
        assert_eq!(
            create_attachment_cli(&conn, &uuid, None, Some("no-such"), "a", "t", 1).unwrap_err().code,
            "COMMENT_NOT_FOUND"
        );
        assert_eq!(
            create_attachment_cli(&conn, &uuid, Some("no-such"), None, "a", "t", 1).unwrap_err().code,
            "TASK_NOT_FOUND"
        );
        assert!(get_attachment_cli(&conn, "no-such").is_none());
    }

    #[test]
    fn now_iso_matches_node_format() {
        let stamp = now_iso();
        // YYYY-MM-DDTHH:MM:SS.sssZ（毫秒 3 位）
        assert_eq!(stamp.len(), 24);
        assert_eq!(&stamp[4..5], "-");
        assert_eq!(&stamp[10..11], "T");
        assert_eq!(&stamp[19..20], ".");
        assert_eq!(&stamp[23..], "Z");
    }

    /* ==== CLI（taskctl）口径扩展 ==== */

    /// CLI 宽形状必须是 27 字段全集（对齐 cli/database.mjs #taskJson 的键集合）
    #[test]
    fn task_full_json_has_all_27_fields() {
        let conn = test_db();
        let actor = Actor::agent("codex-agent", "Codex Agent");
        let spec = TaskCreateSpec {
            project_id: "local",
            title: "宽形状任务",
            description: "描述",
            status: "todo",
            priority: "high",
            labels: &["cli".to_string(), "m3".to_string()],
            thread_id: Some("th-wide"),
            start_date: Some("2026-08-01"),
            due_date: Some("2026-08-31"),
            assignee: None,
        };
        let task = create_task_ex(&conn, &spec, &actor).unwrap();
        let keys: Vec<&str> = task.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        let expected = [
            "id", "identifier", "projectId", "title", "description", "status", "priority",
            "labels", "sortOrder", "threadId", "creatorType", "creatorId", "creatorName",
            "creatorAvatarUrl", "assigneeType", "assigneeId", "assigneeName",
            "assigneeAvatarUrl", "workflowId", "developmentContext", "recurrence",
            "startDate", "dueDate", "archivedAt", "version", "createdAt", "updatedAt",
        ];
        assert_eq!(keys.len(), 27);
        for key in expected {
            assert!(task.as_object().unwrap().contains_key(key), "缺字段：{key}");
        }
        // 关键值语义：actor 落 creator/assignee、labels 数组、日期、version 从 1 起
        assert_eq!(task["creatorId"], "codex-agent");
        assert_eq!(task["creatorType"], "agent");
        assert_eq!(task["assigneeId"], "codex-agent");
        assert_eq!(task["threadId"], "th-wide");
        assert_eq!(task["labels"], json!(["cli", "m3"]));
        assert_eq!(task["startDate"], "2026-08-01");
        assert_eq!(task["dueDate"], "2026-08-31");
        assert_eq!(task["version"], 1);
        assert_eq!(task["identifier"], "LOCAL-1");
        assert!(task["developmentContext"].is_null());
        assert!(task["recurrence"].is_null());
        assert!(task["archivedAt"].is_null());
        assert!(task["creatorAvatarUrl"].is_null());
        // 自定义 assignee 覆盖（--assignee 扩展）
        let assignee = Actor::agent("claude-agent", "Claude");
        let spec2 = TaskCreateSpec {
            project_id: "local",
            title: "指定负责人",
            description: "",
            status: "backlog",
            priority: "none",
            labels: &[],
            thread_id: Some("th-wide"),
            start_date: None,
            due_date: None,
            assignee: Some(&assignee),
        };
        let task2 = create_task_ex(&conn, &spec2, &actor).unwrap();
        assert_eq!(task2["creatorId"], "codex-agent");
        assert_eq!(task2["assigneeId"], "claude-agent");
    }

    /// create_task（挂件口径）actor 参数化：传 local_user_actor 与旧版固定行为一致
    #[test]
    fn create_task_widget_path_uses_passed_actor() {
        let conn = test_db();
        let task = create_task(&conn, "挂件任务", "todo", "none", None, &local_user_actor()).unwrap();
        assert_eq!(task["creatorType"], "user");
        assert_eq!(task["threadId"], "taskboard-widget");
        let row: (String, String) = conn
            .query_row(
                "SELECT creator_id, assignee_id FROM tasks WHERE id = ?1",
                rusqlite::params![task["id"].as_str().unwrap()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(row, ("local-user".to_string(), "local-user".to_string()));
    }

    /// activity list 聚合语义：thread 过滤圈会话 + since-id 游标只取其后（rowid 序）
    #[test]
    fn list_activity_feed_thread_filter_and_cursor() {
        let conn = test_db();
        let agent = Actor::agent("codex-agent", "Codex Agent");
        let mk = |title: &str, thread: &str| {
            let spec = TaskCreateSpec {
                project_id: "local", title, description: "", status: "todo", priority: "none",
                labels: &[], thread_id: Some(thread), start_date: None, due_date: None, assignee: None,
            };
            create_task_ex(&conn, &spec, &agent).unwrap()
        };
        let a = mk("会话A任务", "th-a");
        let b = mk("会话B任务", "th-b");
        let a_id = a["id"].as_str().unwrap().to_string();
        let b_id = b["id"].as_str().unwrap().to_string();
        // A、B 各流转一次（agent actor 落活动流）
        move_task(&conn, &a_id, 1, "in_progress", None, Some("th-a"), &agent).unwrap();
        move_task(&conn, &b_id, 1, "done", None, Some("th-b"), &agent).unwrap();

        // 无过滤：两条（跨全部任务）
        let all = list_activity_feed(&conn, None, None);
        assert_eq!(all.len(), 2);
        // 活动项字段：id/taskId/taskIdentifier/taskTitle/actorType/actorId/actorName/
        // actorAvatarUrl/changes(数组)/createdAt
        let first = &all[0];
        for key in ["id", "taskId", "taskIdentifier", "taskTitle", "actorType", "actorId",
                    "actorName", "actorAvatarUrl", "changes", "createdAt"] {
            assert!(first.as_object().unwrap().contains_key(key), "活动缺字段：{key}");
        }
        assert_eq!(first["actorId"], "codex-agent");
        assert_eq!(first["actorType"], "agent");
        assert!(first["changes"].is_array());
        assert_eq!(first["changes"][0]["field"], "status");
        assert_eq!(first["changes"][0]["before"], "todo");

        // thread 过滤：只看 th-a 会话（按任务 threadId 归属聚合）
        let only_a = list_activity_feed(&conn, Some("th-a"), None);
        assert_eq!(only_a.len(), 1);
        assert_eq!(only_a[0]["taskId"], json!(a_id));
        assert_eq!(only_a[0]["taskIdentifier"], a["identifier"]);

        // since-id 游标：以末条活动 id 为游标 → 其后为空
        let last_id = all[1]["id"].as_str().unwrap().to_string();
        assert!(list_activity_feed(&conn, None, Some(&last_id)).is_empty());
        // 以首条活动 id 为游标 → 只剩末条
        let first_id = all[0]["id"].as_str().unwrap().to_string();
        let after_first = list_activity_feed(&conn, None, Some(&first_id));
        assert_eq!(after_first.len(), 1);
        assert_eq!(after_first[0]["id"], json!(last_id));
        // 未知游标视为无游标（COALESCE -1）
        assert_eq!(list_activity_feed(&conn, None, Some("no-such-activity")).len(), 2);
    }

    /// issue get 宽形状：task 27 字段 + comments + activities
    #[test]
    fn get_task_full_shape() {
        let conn = test_db();
        let agent = Actor::agent("codex-agent", "Codex Agent");
        let spec = TaskCreateSpec {
            project_id: "local", title: "详情任务", description: "正文", status: "todo",
            priority: "none", labels: &[], thread_id: Some("th-detail"),
            start_date: None, due_date: None, assignee: None,
        };
        let task = create_task_ex(&conn, &spec, &agent).unwrap();
        let id = task["id"].as_str().unwrap().to_string();
        move_task(&conn, &id, 1, "in_progress", None, Some("th-detail"), &agent).unwrap();

        let detail = get_task_full(&conn, &id).unwrap();
        assert_eq!(detail.as_object().unwrap().len(), 29); // 27 + comments + activities
        assert_eq!(detail["activities"].as_array().unwrap().len(), 1);
        assert_eq!(detail["activities"][0]["changes"][0]["field"], "status");
        assert_eq!(detail["comments"], json!([]));
        // identifier 也能定位
        assert!(get_task_full(&conn, "LOCAL-1").is_some());
        assert!(get_task_full(&conn, "no-such").is_none());
    }

    /// update_task：thread 随写 + agent actor 落活动流（挂件传 None 不动 thread）
    #[test]
    fn update_task_thread_and_actor() {
        let conn = test_db();
        let agent = Actor::agent("codex-agent", "Codex Agent");
        let spec = TaskCreateSpec {
            project_id: "local", title: "更新任务", description: "", status: "todo",
            priority: "none", labels: &[], thread_id: Some("th-old"),
            start_date: None, due_date: None, assignee: None,
        };
        let task = create_task_ex(&conn, &spec, &agent).unwrap();
        let id = task["id"].as_str().unwrap().to_string();

        // CLI：thread 变化随写 + agent actor 活动流
        update_task(&conn, &id, 1, &json!({ "priority": "urgent" }), Some("th-new"), &agent).unwrap();
        let updated = get_task_wide(&conn, &id).unwrap();
        assert_eq!(updated["threadId"], "th-new");
        assert_eq!(updated["priority"], "urgent");
        assert_eq!(updated["version"], 2);
        let (actor_id, changes): (String, String) = conn
            .query_row(
                "SELECT actor_id, changes FROM task_activities WHERE task_id = ?1",
                rusqlite::params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(actor_id, "codex-agent");
        assert!(changes.contains("\"field\":\"priority\""));
        assert!(changes.contains("\"before\":\"none\""));
        assert!(changes.contains("\"after\":\"urgent\""));

        // 挂件：thread=None 不改归属；本地用户 actor
        update_task(&conn, &id, 2, &json!({ "title": "改标题" }), None, &local_user_actor()).unwrap();
        let after = get_task_wide(&conn, &id).unwrap();
        assert_eq!(after["threadId"], "th-new");
        let (actor_id2, _): (String, String) = conn
            .query_row(
                "SELECT actor_id, changes FROM task_activities WHERE task_id = ?1 ORDER BY rowid DESC LIMIT 1",
                rusqlite::params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(actor_id2, "local-user");

        // assignee 更新（CLI 扩展）：agent 三列 + 活动流 diff
        update_task(&conn, &id, 3, &json!({ "assignee": "claude-agent" }), None, &agent).unwrap();
        let assigned = get_task_wide(&conn, &id).unwrap();
        assert_eq!(assigned["assigneeId"], "claude-agent");
        assert_eq!(assigned["assigneeType"], "agent");
        assert_eq!(assigned["assigneeName"], "claude-agent");
    }

    /// project create / list 宽形状 + PROJECT_EXISTS 冲突
    #[test]
    fn create_project_and_list_full() {
        let conn = test_db();
        let project = create_project(&conn, "my-proj", "我的项目", Some("D:/work")).unwrap();
        assert_eq!(project["id"], "my-proj");
        assert_eq!(project["name"], "我的项目");
        assert_eq!(project["workspacePath"], "D:/work");
        assert!(project["labels"].is_array());
        assert!(project["createdAt"].is_string());
        // id 冲突 → PROJECT_EXISTS（CLI 映射 409 → 退出码 5）
        assert_eq!(create_project(&conn, "my-proj", "再来", None).unwrap_err().code, "PROJECT_EXISTS");
        // 宽形状列表含 local seed + 新项目
        let projects = list_projects_full(&conn);
        assert_eq!(projects.len(), 2);
        let local = projects.iter().find(|p| p["id"] == "local").unwrap();
        assert!(local["workspacePath"].is_null());
    }

    /// list_tasks_full：过滤器 + archived 语义（默认 false / true / all）
    #[test]
    fn list_tasks_full_filters() {
        let conn = test_db();
        let agent = Actor::agent("codex-agent", "Codex Agent");
        let mk = |title: &str, status: &str, priority: &str, labels: &[String], thread: &str| {
            let spec = TaskCreateSpec {
                project_id: "local", title, description: "", status, priority,
                labels, thread_id: Some(thread), start_date: None, due_date: None, assignee: None,
            };
            create_task_ex(&conn, &spec, &agent).unwrap()
        };
        let a = mk("搜索关键词甲", "todo", "high", &["标签A".to_string()], "th-1");
        let b = mk("普通任务", "backlog", "none", &[], "th-2");
        let a_id = a["id"].as_str().unwrap().to_string();
        archive_task(&conn, &a_id, 1, &agent).unwrap();

        let none_filter = TaskListFilter {
            project_id: None, status: None, priority: None, assignee_id: None, creator_id: None,
            label: None, thread_id: None, archived: Some(false), search: None,
        };
        // 默认只看未归档
        let active = list_tasks_full(&conn, &none_filter);
        assert_eq!(active.len(), 1);
        assert_eq!(active[0]["title"], "普通任务");
        // all：含归档
        let all = list_tasks_full(&conn, &TaskListFilter { archived: None, ..none_filter });
        assert_eq!(all.len(), 2);
        // 只看归档
        let archived = list_tasks_full(&conn, &TaskListFilter { archived: Some(true), ..none_filter });
        assert_eq!(archived.len(), 1);
        assert_eq!(archived[0]["title"], "搜索关键词甲");
        // 状态过滤
        let todo = list_tasks_full(&conn, &TaskListFilter { status: Some("todo"), ..none_filter });
        assert!(todo.is_empty()); // 唯一 todo 已归档
        // 标签过滤（JSON 元素精确匹配）
        let labeled = list_tasks_full(&conn, &TaskListFilter { label: Some("标签A"), archived: None, ..none_filter });
        assert_eq!(labeled.len(), 1);
        // 搜索（标题包含）
        let searched = list_tasks_full(&conn, &TaskListFilter { search: Some("关键词"), archived: None, ..none_filter });
        assert_eq!(searched.len(), 1);
        assert_eq!(searched[0]["title"], "搜索关键词甲");
        // thread 过滤
        let th1 = list_tasks_full(&conn, &TaskListFilter { thread_id: Some("th-1"), archived: None, ..none_filter });
        assert_eq!(th1.len(), 1);
        // assignee/creator 过滤（agent 建的都落 codex-agent）
        let mine = list_tasks_full(&conn, &TaskListFilter { creator_id: Some("codex-agent"), archived: None, ..none_filter });
        assert_eq!(mine.len(), 2);
        void_value(&b);
    }

    fn void_value(_v: &Value) {}
}
