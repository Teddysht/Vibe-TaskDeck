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
/// sortOrder：显式传入（拖拽落点排序）优先；缺省按上游惯例（状态变化→min−1000；未变→max+1000）
pub fn move_task(
    conn: &Connection,
    id: &str,
    version: i64,
    status: &str,
    sort_order: Option<f64>,
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

/// 更新任务属性：对齐 upstream updateTask（database.mjs:1803-1940）
/// 白名单 title/description/status/priority/labels/startDate/dueDate；
/// version 乐观并发；labels 变更后与项目标签库合并去重；status 变化置
/// sortOrder=min−1000；活动流只记实际变化字段（taskFieldChanges diff 语义）。
pub fn update_task(
    conn: &Connection,
    id: &str,
    version: i64,
    changes: &Value,
) -> Result<Value, CommandError> {
    let Some(changes_obj) = changes.as_object() else {
        return Err(CommandError::new("INVALID_FIELD", "changes 必须是对象"));
    };
    // 白名单校验（未知键拒绝，对齐上游）
    const WHITELIST: [&str; 7] = [
        "title", "description", "status", "priority", "labels", "startDate", "dueDate",
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
            _ => unreachable!("白名单已过滤"),
        };
        if changed {
            activity_changes.push(json!({
                "field": key,
                "before": field_before(&current, key),
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

/// 归档任务：对齐 upstream archiveTask（database.mjs:1994）
pub fn archive_task(conn: &Connection, id: &str, version: i64) -> Result<Value, CommandError> {
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
        let (actor_type, actor_id, actor_name) = LOCAL_USER_ACTOR;
        conn.execute(
            "INSERT INTO task_activities (
               id, task_id, actor_type, actor_id, actor_name, actor_avatar_url, changes, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7)",
            rusqlite::params![
                uuid::Uuid::new_v4().to_string(),
                current.id,
                actor_type, actor_id, actor_name,
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

/// 恢复归档：对齐 upstream restoreTask（database.mjs:2029）——仅归档任务可恢复
pub fn restore_task(conn: &Connection, id: &str, version: i64) -> Result<Value, CommandError> {
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
        let (actor_type, actor_id, actor_name) = LOCAL_USER_ACTOR;
        conn.execute(
            "INSERT INTO task_activities (
               id, task_id, actor_type, actor_id, actor_name, actor_avatar_url, changes, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7)",
            rusqlite::params![
                uuid::Uuid::new_v4().to_string(),
                current.id,
                actor_type, actor_id, actor_name,
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
            if let Some(data_dir) = std::env::var("CODEX_TASKBOARD_DATA_DIR").ok().filter(|s| !s.trim().is_empty())
                .or_else(|| std::env::var("APPDATA").ok()) {
                let base = if std::env::var("CODEX_TASKBOARD_DATA_DIR").ok().filter(|s| !s.trim().is_empty()).is_some() {
                    std::path::PathBuf::from(data_dir)
                } else {
                    std::path::PathBuf::from(data_dir).join("dashi-taskboard")
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

/// 附件 id 安全校验：UUID 格式（构造性免疫路径穿越；返回规范路径段）
fn sanitize_attachment_id(id: &str) -> Option<&str> {
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

/// 附件目录（与上游同位：<数据目录>/attachments；构造性安全——只存 UUID 文件名）
fn attachments_dir() -> Option<std::path::PathBuf> {
    let data_dir = std::env::var("CODEX_TASKBOARD_DATA_DIR")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var("APPDATA")
                .ok()
                .map(|d| std::path::PathBuf::from(d).join("dashi-taskboard"))
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
    /// 回归：list_tasks 必须带 creatorType——曾因缺字段导致挂件 L1/L2 的
    /// agent 徽标对真实数据不渲染（mock 数据自带字段掩盖了缺口）
    fn list_tasks_includes_creator_type() {
        let conn = test_db();
        create_task(&conn, "用户任务", "todo", "none", None).unwrap();
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
        let task = create_task(&conn, "流转任务", "todo", "none", None).unwrap();
        let id = task["id"].as_str().unwrap().to_string();
        let moved = move_task(&conn, &id, 1, "in_progress", None).unwrap();
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
        move_task(&conn, &id, 1, "in_progress", None).unwrap();
        // 用过期 version 1 再次流转 → VERSION_CONFLICT
        let conflict = move_task(&conn, &id, 1, "done", None).unwrap_err();
        assert_eq!(conflict.code, "VERSION_CONFLICT");
        // 任务不存在
        assert_eq!(move_task(&conn, "no-such", 1, "done", None).unwrap_err().code, "TASK_NOT_FOUND");
    }

    #[test]
    fn issue_detail_returns_task_comments_and_activities() {
        let conn = test_db();
        let task = create_task(&conn, "详情任务", "todo", "high", None).unwrap();
        let id = task["id"].as_str().unwrap().to_string();
        add_comment(&conn, &id, "第一条评论").unwrap();
        add_comment(&conn, &id, "第二条评论").unwrap();
        move_task(&conn, &id, 1, "in_progress", None).unwrap();

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
    fn archive_restore_delete_lifecycle() {
        let conn = test_db();
        let task = create_task(&conn, "归档生命周期", "todo", "none", None).unwrap();
        let id = task["id"].as_str().unwrap().to_string();
        // 未归档：删除/恢复均拒绝（对齐上游）
        assert_eq!(delete_task(&conn, &id, 1).unwrap_err().code, "TASK_NOT_ARCHIVED");
        assert_eq!(restore_task(&conn, &id, 1).unwrap_err().code, "TASK_NOT_ARCHIVED");
        // 归档 → archivedAt 非空 + version+1
        let archived = archive_task(&conn, &id, 1).unwrap();
        assert!(archived["archivedAt"].as_str().is_some());
        // 重复归档（version 过期）→ 冲突
        assert_eq!(archive_task(&conn, &id, 1).unwrap_err().code, "VERSION_CONFLICT");
        // 恢复成功
        let restored = restore_task(&conn, &id, 2).unwrap();
        assert!(restored["archivedAt"].is_null());
        // 归档后删除成功
        archive_task(&conn, &id, 3).unwrap();
        let deleted = delete_task(&conn, &id, 4).unwrap();
        assert_eq!(deleted["ok"], serde_json::json!(true));
        // 删除后不可再查
        assert_eq!(issue_detail(&conn, &id).unwrap_err().code, "TASK_NOT_FOUND");
    }

    #[test]
    fn project_label_crud_and_task_cleanup() {
        let conn = test_db();
        let task = create_task(&conn, "带标签", "todo", "none", None).unwrap();
        let id = task["id"].as_str().unwrap().to_string();
        // update_task 加标签 → 项目标签库自动合并
        update_task(&conn, &id, 1, &serde_json::json!({ "labels": ["自定义"] })).unwrap();
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
        let a = create_task(&conn, "任务A", "todo", "none", None).unwrap();
        let b = create_task(&conn, "任务B", "todo", "none", None).unwrap();
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
        let c = create_task(&conn, "任务C", "todo", "none", None).unwrap();
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
        std::env::set_var("CODEX_TASKBOARD_DATA_DIR", &tmp);
        let conn = test_db();
        let task = create_task(&conn, "带附件", "todo", "none", None).unwrap();
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
