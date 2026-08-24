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
const WIDGET_THREAD_ID: &str = "taskboard-widget";

/// 挂件侧 actor：本地用户（与上游 app.mjs 无头请求的默认 actor 一致）
const LOCAL_USER_ACTOR: (&str, &str, &str) = ("user", "local-user", "本地用户");

const TASK_STATUSES: [&str; 7] = ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled"];
const TASK_PRIORITIES: [&str; 5] = ["none", "urgent", "high", "medium", "low"];

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

/// 数据库路径：CODEX_TASKBOARD_DATA_DIR > %APPDATA%\dashi-taskboard
/// （与 cli/taskctl-local.mjs、upstream server 的解析规则保持一致，三方同库）
fn resolve_db_path() -> Result<PathBuf, String> {
    if let Ok(dir) = std::env::var("CODEX_TASKBOARD_DATA_DIR") {
        let dir = dir.trim();
        if !dir.is_empty() {
            return Ok(PathBuf::from(dir).join("taskboard.sqlite"));
        }
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        let appdata = appdata.trim();
        if !appdata.is_empty() {
            return Ok(PathBuf::from(appdata).join("dashi-taskboard").join("taskboard.sqlite"));
        }
    }
    Err("无法定位数据目录：请设置 CODEX_TASKBOARD_DATA_DIR 环境变量".into())
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
        "SELECT id, identifier, project_id, title, status, priority, labels, sort_order,
                thread_id, start_date, due_date, archived_at, version, created_at, updated_at
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
            status: row.get(4)?,
            priority: row.get(5)?,
            labels: row.get(6)?,
            sort_order: row.get(7)?,
            thread_id: row.get(8)?,
            start_date: row.get(9)?,
            due_date: row.get(10)?,
            archived_at: row.get(11)?,
            version: row.get(12)?,
            created_at: row.get(13)?,
            updated_at: row.get(14)?,
        })
    });
    match rows {
        Ok(rows) => rows.filter_map(|r| r.ok()).map(task_to_json).collect(),
        Err(_) => Vec::new(),
    }
}

/// 项目列表：挂件只需要 id/name
pub fn list_projects(conn: &Connection) -> Vec<Value> {
    let mut stmt = match conn.prepare("SELECT id, name FROM projects ORDER BY created_at, id") {
        Ok(stmt) => stmt,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)));
    match rows {
        Ok(rows) => rows
            .filter_map(|r| r.ok())
            .map(|(id, name)| json!({ "id": id, "name": name }))
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
}

fn task_to_json(t: TaskColumns) -> Value {
    let labels: Value = serde_json::from_str(&t.labels).unwrap_or(json!([]));
    json!({
        "id": t.id,
        "identifier": t.identifier,
        "projectId": t.project_id,
        "title": t.title,
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
    })
}

fn get_task_columns(conn: &Connection, id: &str) -> rusqlite::Result<Option<TaskColumns>> {
    let mut stmt = conn.prepare(
        "SELECT id, identifier, project_id, title, status, priority, labels, sort_order,
                thread_id, start_date, due_date, archived_at, version, created_at, updated_at
         FROM tasks WHERE id = ?1 OR identifier = ?1",
    )?;
    let mut rows = stmt.query_map(rusqlite::params![id], |row| {
        Ok(TaskColumns {
            id: row.get(0)?,
            identifier: row.get(1)?,
            project_id: row.get(2)?,
            title: row.get(3)?,
            status: row.get(4)?,
            priority: row.get(5)?,
            labels: row.get(6)?,
            sort_order: row.get(7)?,
            thread_id: row.get(8)?,
            start_date: row.get(9)?,
            due_date: row.get(10)?,
            archived_at: row.get(11)?,
            version: row.get(12)?,
            created_at: row.get(13)?,
            updated_at: row.get(14)?,
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

    conn.execute_batch("BEGIN IMMEDIATE")?;
    match create_task_inner(conn, title, status, priority, due_date) {
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

fn create_task_inner(
    conn: &Connection,
    title: &str,
    status: &str,
    priority: &str,
    due_date: Option<&str>,
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
             FROM projects WHERE id = 'local'",
            [],
            |row| {
                Ok(ProjectRow {
                    labels: row.get(0)?,
                    next_task_number: row.get(1)?,
                    first_identifier: row.get(2)?,
                })
            },
        )
        .map_err(|_| CommandError::new("PROJECT_NOT_FOUND", "默认项目 local 不存在"))?;

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
            _ => project_prefix("local"),
        },
        None => project_prefix("local"),
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
         WHERE project_id = 'local' AND status = ?1 AND archived_at IS NULL",
        rusqlite::params![status],
        |row| row.get(0),
    )?;
    let sort_order = minimum.map_or(1000.0, |min| min - 1000.0);

    // 推进项目编号；labels 与项目合并去重（挂件无自定义 labels，等价于原样保留）
    let mut labels: Vec<String> = serde_json::from_str(&project.labels).unwrap_or_default();
    labels.dedup();
    conn.execute(
        "UPDATE projects SET next_task_number = ?1, labels = ?2, updated_at = ?3 WHERE id = 'local'",
        rusqlite::params![number + 1, serde_json::to_string(&labels).unwrap_or_else(|_| "[]".into()), timestamp],
    )?;

    let (actor_type, actor_id, actor_name) = LOCAL_USER_ACTOR;
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
         ) VALUES (?1, ?2, 'local', ?3, '', ?4, ?5, '[]',
                   ?6, ?7, NULL, NULL, NULL, NULL,
                   ?8, ?9, ?10, NULL,
                   ?8, ?9, ?10, NULL,
                   NULL, NULL, NULL, NULL,
                   NULL, ?11, NULL, NULL,
                   NULL, 1, ?12, ?12)",
        rusqlite::params![
            id,
            identifier,
            title,
            status,
            priority,
            sort_order,
            WIDGET_THREAD_ID,
            actor_type,
            actor_id,
            actor_name,
            due_date,
            timestamp,
        ],
    )?;

    get_task_columns(conn, &id)?
        .map(task_to_json)
        .ok_or_else(|| CommandError::new("DB_ERROR", "创建后读取任务失败"))
}

/// 流转任务：对齐 upstream moveTask（database.mjs:1942-1992）
pub fn move_task(conn: &Connection, id: &str, version: i64, status: &str) -> Result<Value, CommandError> {
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
    let sort_order = if status != current.status {
        let minimum: Option<f64> = conn.query_row(
            "SELECT MIN(sort_order) FROM tasks
             WHERE project_id = ?1 AND status = ?2 AND archived_at IS NULL AND id != ?3",
            rusqlite::params![current.project_id, status, current.id],
            |row| row.get(0),
        )?;
        minimum.map_or(1000.0, |min| min - 1000.0)
    } else {
        let maximum: f64 = conn.query_row(
            "SELECT COALESCE(MAX(sort_order), 0) FROM tasks
             WHERE project_id = ?1 AND status = ?2 AND archived_at IS NULL AND id != ?3",
            rusqlite::params![current.project_id, status, current.id],
            |row| row.get(0),
        )?;
        maximum + 1000.0
    };

    let timestamp = now_iso();
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let result = (|| -> Result<Value, CommandError> {
        let updated = conn.execute(
            "UPDATE tasks
             SET status = ?1, sort_order = ?2,
                 thread_id = ?3, thread_codex_project_id = NULL, thread_codex_project_kind = NULL,
                 thread_codex_host_id = NULL, thread_workspace_path = NULL,
                 version = version + 1, updated_at = ?4
             WHERE id = ?5 AND version = ?6",
            rusqlite::params![status, sort_order, WIDGET_THREAD_ID, timestamp, current.id, version],
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
            let (actor_type, actor_id, actor_name) = LOCAL_USER_ACTOR;
            conn.execute(
                "INSERT INTO task_activities (
                   id, task_id, actor_type, actor_id, actor_name, actor_avatar_url, changes, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7)",
                rusqlite::params![
                    uuid::Uuid::new_v4().to_string(),
                    current.id,
                    actor_type,
                    actor_id,
                    actor_name,
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

    // 评论：ORDER BY 逐字对齐 upstream listComments（created_at, id）
    let mut comments: Vec<Value> = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT id, body, author_type, author_name, version, created_at
         FROM comments WHERE task_id = ?1 ORDER BY created_at, id",
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

    // 活动流：ORDER BY 对齐 upstream listTaskActivities
    let mut activities: Vec<Value> = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT actor_type, actor_name, changes, created_at
         FROM task_activities WHERE task_id = ?1 ORDER BY created_at, id",
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
    Ok(json!({ "task": task_json, "comments": comments, "activities": activities }))
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
        let task = create_task(&conn, "测试任务", "backlog", "high", Some("2026-12-31")).unwrap();
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
        assert_eq!(create_task(&conn, "", "backlog", "none", None).unwrap_err().code, "INVALID_FIELD");
        assert_eq!(
            create_task(&conn, "标题", "bad_status", "none", None).unwrap_err().code,
            "INVALID_FIELD"
        );
        assert_eq!(
            create_task(&conn, "标题", "backlog", "bad_priority", None).unwrap_err().code,
            "INVALID_FIELD"
        );
    }

    #[test]
    fn move_task_updates_status_version_and_activity() {
        let conn = test_db();
        let task = create_task(&conn, "流转任务", "todo", "none", None).unwrap();
        let id = task["id"].as_str().unwrap().to_string();
        let moved = move_task(&conn, &id, 1, "in_progress").unwrap();
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
        let task = create_task(&conn, "冲突任务", "todo", "none", None).unwrap();
        let id = task["id"].as_str().unwrap().to_string();
        move_task(&conn, &id, 1, "in_progress").unwrap();
        // 用过期 version 1 再次流转 → VERSION_CONFLICT
        let conflict = move_task(&conn, &id, 1, "done").unwrap_err();
        assert_eq!(conflict.code, "VERSION_CONFLICT");
        // 任务不存在
        assert_eq!(move_task(&conn, "no-such", 1, "done").unwrap_err().code, "TASK_NOT_FOUND");
    }

    #[test]
    fn issue_detail_returns_task_comments_and_activities() {
        let conn = test_db();
        let task = create_task(&conn, "详情任务", "todo", "high", None).unwrap();
        let id = task["id"].as_str().unwrap().to_string();
        add_comment(&conn, &id, "第一条评论").unwrap();
        add_comment(&conn, &id, "第二条评论").unwrap();
        move_task(&conn, &id, 1, "in_progress").unwrap();

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
        let task = create_task(&conn, "评论任务", "todo", "none", None).unwrap();
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
    fn now_iso_matches_node_format() {
        let stamp = now_iso();
        // YYYY-MM-DDTHH:MM:SS.sssZ（毫秒 3 位）
        assert_eq!(stamp.len(), 24);
        assert_eq!(&stamp[4..5], "-");
        assert_eq!(&stamp[10..11], "T");
        assert_eq!(&stamp[19..20], ".");
        assert_eq!(&stamp[23..], "Z");
    }
}
