/* ==== 自研数据层（替换 ../upstream/server/database.mjs）====
 *
 * 上游快照不入库且本机已缺失（import 必失败），此处按两处权威参照重建：
 *   1. cli/taskctl-local.mjs 的全部 db.xxx(...) 调用点——方法签名逐点服从，
 *      输出字段名（camelCase）以 CLI 取值表达式与 widget/web 消费字段为准；
 *   2. widget/src-tauri/src/db.rs——DDL/PRAGMA/事务/乐观锁/活动流逐字对齐，
 *      与挂件 Rust 侧同库（WAL）互操作。
 *
 * 互操作契约（三方同库：挂件 Rust / taskctl Node / 上游 server）：
 *   · DDL 逐字对齐 db.rs #migrate()：全部 CREATE TABLE/INDEX IF NOT EXISTS，幂等
 *   · PRAGMA 三件套：journal_mode=WAL / busy_timeout=5000 / foreign_keys=ON
 *   · 乐观锁：version 不匹配 → ApiError(409, "VERSION_CONFLICT")，
 *     taskctl-local.mjs 据此分发退出码 5（status===409）
 *   · 活动流：写操作落 task_activities，changes = [{"field","before","after"}]，
 *     actor 记录 actor_type/actor_id/actor_name（与 db.rs 同构；真实库样本验证）
 *
 * 底层用 Node 22.5+ 内置 node:sqlite（DatabaseSync），无第三方依赖。
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { isTaskPriority, isTaskStatus } from "./domain.mjs";

/* ==== 与上游 shared/domain.mjs 的 DEFAULT_LABEL_NAMES 一致（projects.labels 默认值）==== */
const DEFAULT_PROJECT_LABELS_JSON =
  '["缺陷","特性","for-claude","hold","改进","phase-1","phase-2","phase-3","phase-4","phase-5","phase-6"]';

/* ==== API 错误：status 对齐 HTTP 语义，taskctl-local 按其分发退出码（409→5，其余→4）==== */
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

const TASK_SELECT_COLUMNS = `id, identifier, project_id, title, description, status, priority, labels, sort_order,
       thread_id, thread_codex_project_id, thread_codex_project_kind, thread_codex_host_id, thread_workspace_path,
       creator_type, creator_id, creator_name, creator_avatar_url,
       assignee_type, assignee_id, assignee_name, assignee_avatar_url,
       workflow_id, git_branch, worktree_path, worktree_branch,
       start_date, due_date, recurrence_interval, recurrence_unit,
       archived_at, version, created_at, updated_at`;

const VERSION_CONFLICT_MESSAGE = "Task was modified by another session; reload and retry with the current version";

export class TaskboardDatabase {
  #db;

  /** 打开（必要时创建）数据库：建目录 + PRAGMA + 建表 + seed 默认项目 */
  constructor(dbFile) {
    const directory = path.dirname(dbFile);
    if (directory && directory !== "." && !dbFile.startsWith(":memory:")) {
      mkdirSync(directory, { recursive: true });
    }
    this.#db = new DatabaseSync(dbFile);
    this.#db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.#migrate();
    this.#seedLocalProject();
  }

  close() {
    this.#db.close();
  }

  /* ==== schema：DDL 逐字对齐 widget/src-tauri/src/db.rs #migrate() ==== */
  #migrate() {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        workspace_path TEXT,
        labels TEXT NOT NULL DEFAULT '${DEFAULT_PROJECT_LABELS_JSON}',
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
    `);
  }

  /* ==== seed 默认项目 local「全局」，对齐 db.rs #seed_local_project ==== */
  #seedLocalProject() {
    const timestamp = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO projects (id, name, workspace_path, next_task_number, created_at, updated_at)
         VALUES ('local', '全局', NULL, 1, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(timestamp, timestamp);
    this.#db
      .prepare(
        `UPDATE projects
         SET name = '全局', workspace_path = NULL, updated_at = ?
         WHERE id = 'local' AND (name != '全局' OR workspace_path IS NOT NULL)`,
      )
      .run(timestamp);
  }

  /* ============================================================
   * 项目
   * ============================================================ */

  listProjects() {
    const rows = this.#db
      .prepare("SELECT id, name, workspace_path, labels, created_at, updated_at FROM projects ORDER BY created_at, id")
      .all();
    return rows.map((row) => this.#projectJson(row));
  }

  createProject({ id, name, workspacePath }) {
    const existing = this.#db.prepare("SELECT id FROM projects WHERE id = ?").get(id);
    if (existing) {
      throw new ApiError(409, "PROJECT_EXISTS", `Project '${id}' already exists`);
    }
    const timestamp = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO projects (id, name, workspace_path, labels, next_task_number, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(id, name, workspacePath ?? null, DEFAULT_PROJECT_LABELS_JSON, timestamp, timestamp);
    const row = this.#db
      .prepare("SELECT id, name, workspace_path, labels, created_at, updated_at FROM projects WHERE id = ?")
      .get(id);
    return this.#projectJson(row);
  }

  #projectJson(row) {
    return {
      id: row.id,
      name: row.name,
      workspacePath: row.workspace_path,
      labels: this.#parseJsonArray(row.labels),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /* ============================================================
   * 任务查询
   * ============================================================ */

  /**
   * 任务列表：过滤器 { projectId, status, archived, threadId, updatedSince }。
   * archived："true" 只看归档 / "false" 只看未归档 / undefined 不过滤（即 CLI 的 --archived all；
   * 路由默认值「未传只看未归档」由 taskctl-local 在调用前归一化，本层不重复默认）。
   * threadId：按会话归属圈定（tasks.thread_id 精确匹配，AI 协议双向化新增）。
   * updatedSince：ISO 8601 时间戳，只看 updated_at 严格大于该值的任务（增量回执）。
   * ORDER BY 逐字对齐 db.rs #list_tasks（看板列序 → sort_order → created_at → id）。
   */
  listTasks({ projectId, status, archived, threadId, updatedSince } = {}) {
    const clauses = [];
    const params = [];
    if (projectId !== undefined && projectId !== null && projectId !== "") {
      clauses.push("project_id = ?");
      params.push(projectId);
    }
    if (status !== undefined && status !== null && status !== "") {
      clauses.push("status = ?");
      params.push(status);
    }
    if (threadId !== undefined && threadId !== null && threadId !== "") {
      clauses.push("thread_id = ?");
      params.push(threadId);
    }
    if (updatedSince !== undefined && updatedSince !== null && updatedSince !== "") {
      clauses.push("updated_at > ?");
      params.push(updatedSince);
    }
    if (archived === "true") {
      clauses.push("archived_at IS NOT NULL");
    } else if (archived === "false") {
      clauses.push("archived_at IS NULL");
    }
    // archived 为 undefined/null：不按归档过滤（CLI --archived all 语义）
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.#db
      .prepare(
        `SELECT ${TASK_SELECT_COLUMNS} FROM tasks
         ${whereSql}
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
           sort_order, created_at, id`,
      )
      .all(...params);
    return rows.map((row) => this.#taskJson(row));
  }

  /** 任务详情：按 id 或 identifier 均可定位（对齐 db.rs #get_task_columns）；附评论与活动流 */
  getTask(taskId) {
    const row = this.#taskRow(taskId);
    if (!row) return null;
    return {
      ...this.#taskJson(row),
      comments: this.listComments(row.id),
      activities: this.listActivities(row.id),
    };
  }

  #taskRow(taskId) {
    return this.#db
      .prepare(`SELECT ${TASK_SELECT_COLUMNS} FROM tasks WHERE id = ? OR identifier = ?`)
      .get(taskId, taskId);
  }

  #requireTaskRow(taskId) {
    const row = this.#taskRow(taskId);
    if (!row) {
      throw new ApiError(404, "TASK_NOT_FOUND", `Task '${taskId}' does not exist`);
    }
    return row;
  }

  #taskJson(row) {
    return {
      id: row.id,
      identifier: row.identifier,
      projectId: row.project_id,
      title: row.title,
      description: row.description,
      status: row.status,
      priority: row.priority,
      labels: this.#parseJsonArray(row.labels),
      sortOrder: row.sort_order,
      threadId: row.thread_id,
      creatorType: row.creator_type,
      creatorId: row.creator_id,
      creatorName: row.creator_name,
      creatorAvatarUrl: row.creator_avatar_url,
      assigneeType: row.assignee_type,
      assigneeId: row.assignee_id,
      assigneeName: row.assignee_name,
      assigneeAvatarUrl: row.assignee_avatar_url,
      workflowId: row.workflow_id,
      developmentContext: this.#developmentContext(row),
      recurrence:
        row.recurrence_interval !== null && row.recurrence_interval !== undefined
          ? { interval: row.recurrence_interval, unit: row.recurrence_unit }
          : null,
      startDate: row.start_date,
      dueDate: row.due_date,
      archivedAt: row.archived_at,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  #developmentContext(row) {
    if (row.git_branch) {
      return { type: "branch", branch: row.git_branch };
    }
    if (row.worktree_path) {
      return { type: "worktree", path: row.worktree_path, branch: row.worktree_branch ?? null };
    }
    return null;
  }

  /* ============================================================
   * 任务写入（事务 + 乐观锁 + 活动流，语义对齐 db.rs）
   * ============================================================ */

  /**
   * 新建任务。入参对齐 taskctl-local issueCreate 的调用形状：
   * { projectId, title, description, status, priority, labels, threadId, workflowId,
   *   developmentContext, startDate, dueDate, recurrence, actor, assignee }
   */
  createTask(input) {
    const title = input.title;
    if (typeof title !== "string" || title.length === 0 || title.length > 240) {
      throw new ApiError(400, "INVALID_FIELD", "'title' must be a non-empty string of at most 240 characters");
    }
    if (!isTaskStatus(input.status)) {
      throw new ApiError(400, "INVALID_FIELD", `Invalid status: ${input.status}`);
    }
    if (!isTaskPriority(input.priority)) {
      throw new ApiError(400, "INVALID_FIELD", `Invalid priority: ${input.priority}`);
    }

    const result = this.#transaction(() => {
      const projectId = input.projectId;
      const project = this.#db
        .prepare(
          `SELECT labels, next_task_number,
                  (SELECT tasks.identifier FROM tasks
                   WHERE tasks.project_id = projects.id
                   ORDER BY tasks.created_at, tasks.id LIMIT 1) AS first_identifier
           FROM projects WHERE id = ?`,
        )
        .get(projectId);
      if (!project) {
        throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
      }

      // identifier 前缀：项目首个任务 identifier 去掉尾部 -数字，否则项目 id 大写去非字母数字截 12
      const prefix = identifierPrefix(project.first_identifier, projectId);
      const glob = `${prefix}-[0-9]*`;
      const maximum = this.#db
        .prepare(
          `SELECT MAX(CAST(substr(identifier, ?) AS INTEGER)) AS number
           FROM tasks WHERE identifier GLOB ?`,
        )
        .get(prefix.length + 2, glob).number;
      const number = Math.max(project.next_task_number, (maximum ?? 0) + 1);
      const identifier = `${prefix}-${number}`;
      const id = randomUUID();
      const timestamp = new Date().toISOString();

      // sortOrder 缺省 = 同项目同状态未归档最小值 − 1000（无则 1000）
      const minimum = this.#db
        .prepare(
          `SELECT MIN(sort_order) AS minimum FROM tasks
           WHERE project_id = ? AND status = ? AND archived_at IS NULL`,
        )
        .get(projectId, input.status).minimum;
      const sortOrder = minimum === null ? 1000 : minimum - 1000;

      // 推进项目编号；任务 labels 与项目标签库合并去重回写
      const labels = [...new Set(input.labels ?? [])];
      const catalog = this.#mergeLabels(this.#parseJsonArray(project.labels), labels);
      this.#db
        .prepare("UPDATE projects SET next_task_number = ?, labels = ?, updated_at = ? WHERE id = ?")
        .run(number + 1, JSON.stringify(catalog), timestamp, projectId);

      const actor = input.actor ?? {};
      const assignee = input.assignee ?? actor;
      const context = input.developmentContext ?? null;
      const recurrence = input.recurrence ?? null;
      this.#db
        .prepare(
          `INSERT INTO tasks (
             id, identifier, project_id, title, description, status, priority, labels,
             sort_order, thread_id, thread_codex_project_id, thread_codex_project_kind,
             thread_codex_host_id, thread_workspace_path,
             creator_type, creator_id, creator_name, creator_avatar_url,
             assignee_type, assignee_id, assignee_name, assignee_avatar_url,
             workflow_id, git_branch, worktree_path, worktree_branch,
             start_date, due_date, recurrence_interval, recurrence_unit,
             archived_at, version, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL,
                     ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)`,
        )
        .run(
          id,
          identifier,
          projectId,
          title,
          input.description ?? "",
          input.status,
          input.priority,
          JSON.stringify(labels),
          sortOrder,
          input.threadId ?? null,
          actor.type ?? "user",
          actor.id ?? "local-user",
          actor.name ?? "本地用户",
          actor.avatarUrl ?? null,
          assignee.type ?? "user",
          assignee.id ?? "local-user",
          assignee.name ?? "本地用户",
          assignee.avatarUrl ?? null,
          input.workflowId ?? null,
          context?.type === "branch" ? context.branch : null,
          context?.type === "worktree" ? context.path : null,
          context?.type === "worktree" ? (context.branch ?? null) : null,
          input.startDate ?? null,
          input.dueDate ?? null,
          recurrence?.interval ?? null,
          recurrence?.unit ?? null,
          timestamp,
          timestamp,
        );
      return this.#taskJson(this.#requireTaskRow(id));
    });
    return result;
  }

  /**
   * 更新任务。调用点：db.updateTask(id, version, changes, threadId, developmentContext, actor)。
   * 白名单 + diff 语义对齐 db.rs #update_task：只记实际变化字段，status 变化置
   * sortOrder=min−1000，labels 变更合并项目标签库，无实际变化不递增 version。
   */
  updateTask(taskId, version, changes, threadId, developmentContext, actor) {
    const WHITELIST = new Set([
      "projectId",
      "title",
      "description",
      "status",
      "priority",
      "labels",
      "startDate",
      "dueDate",
      "developmentContext",
      "recurrence",
      "workflowId",
    ]);
    for (const key of Object.keys(changes)) {
      if (!WHITELIST.has(key)) {
        throw new ApiError(400, "INVALID_FIELD", `Unsupported update field: ${key}`);
      }
    }

    const current = this.#requireTaskRow(taskId);
    if (current.version !== version) {
      throw new ApiError(409, "VERSION_CONFLICT", VERSION_CONFLICT_MESSAGE);
    }
    if (current.archived_at !== null) {
      throw new ApiError(400, "TASK_ARCHIVED", "Archived tasks cannot be updated; restore the task first");
    }

    const setClauses = [];
    const params = [];
    const activityChanges = [];
    const before = this.#taskJson(current);

    const setClause = (column, value) => {
      setClauses.push(`${column} = ?`);
      params.push(value ?? null);
    };
    const diff = (field, afterValue, column, columnValue) => {
      if (JSON.stringify(afterValue) === JSON.stringify(before[field])) return;
      setClause(column, columnValue);
      activityChanges.push({ field, before: before[field], after: afterValue });
    };

    if (changes.projectId !== undefined) {
      const target = this.#db.prepare("SELECT id FROM projects WHERE id = ?").get(changes.projectId);
      if (!target) {
        throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${changes.projectId}' does not exist`);
      }
      diff("projectId", changes.projectId, "project_id", changes.projectId);
    }
    if (changes.title !== undefined) {
      if (typeof changes.title !== "string" || changes.title.length === 0 || changes.title.length > 240) {
        throw new ApiError(400, "INVALID_FIELD", "'title' must be a non-empty string of at most 240 characters");
      }
      diff("title", changes.title, "title", changes.title);
    }
    if (changes.description !== undefined) {
      diff("description", changes.description, "description", changes.description);
    }
    if (changes.status !== undefined) {
      if (!isTaskStatus(changes.status)) {
        throw new ApiError(400, "INVALID_FIELD", `Invalid status: ${changes.status}`);
      }
      if (changes.status !== current.status) {
        // status 变化 → sort_order = 目标状态最小值 − 1000（对齐 db.rs）
        const minimum = this.#db
          .prepare(
            `SELECT MIN(sort_order) AS minimum FROM tasks
             WHERE project_id = ? AND status = ? AND archived_at IS NULL AND id != ?`,
          )
          .get(current.project_id, changes.status, current.id).minimum;
        setClause("status", changes.status);
        setClause("sort_order", minimum === null ? 1000 : minimum - 1000);
        activityChanges.push({ field: "status", before: current.status, after: changes.status });
      }
    }
    if (changes.priority !== undefined) {
      if (!isTaskPriority(changes.priority)) {
        throw new ApiError(400, "INVALID_FIELD", `Invalid priority: ${changes.priority}`);
      }
      diff("priority", changes.priority, "priority", changes.priority);
    }
    if (changes.labels !== undefined) {
      if (JSON.stringify(changes.labels) !== JSON.stringify(before.labels)) {
        setClause("labels", JSON.stringify(changes.labels));
        activityChanges.push({ field: "labels", before: before.labels, after: changes.labels });
      }
    }
    if (changes.startDate !== undefined) {
      diff("startDate", changes.startDate, "start_date", changes.startDate);
    }
    if (changes.dueDate !== undefined) {
      diff("dueDate", changes.dueDate, "due_date", changes.dueDate);
    }
    if (changes.workflowId !== undefined) {
      setClause("workflow_id", changes.workflowId);
    }

    // developmentContext：changes 内或第五参（issueUpdate 两者都可能出现）
    const context = changes.developmentContext !== undefined ? changes.developmentContext : developmentContext;
    if (context !== undefined) {
      if (context === null) {
        setClause("git_branch", null);
        setClause("worktree_path", null);
        setClause("worktree_branch", null);
      } else if (context.type === "branch") {
        setClause("git_branch", context.branch);
        setClause("worktree_path", null);
        setClause("worktree_branch", null);
      } else if (context.type === "worktree") {
        setClause("git_branch", null);
        setClause("worktree_path", context.path);
        setClause("worktree_branch", context.branch ?? null);
      } else {
        throw new ApiError(400, "INVALID_FIELD", "developmentContext must be a branch or worktree context");
      }
    }
    if (changes.recurrence !== undefined) {
      const recurrence = changes.recurrence;
      if (recurrence === null) {
        setClause("recurrence_interval", null);
        setClause("recurrence_unit", null);
      } else {
        setClause("recurrence_interval", recurrence.interval);
        setClause("recurrence_unit", recurrence.unit);
      }
    }
    // 会话归属：threadId 总是显式传入（CLI 强制），变化时随写
    if (threadId !== undefined && threadId !== null && threadId !== current.thread_id) {
      setClause("thread_id", threadId);
    }

    // 无任何实际变化 → 直接返回当前（不递增 version，对齐 db.rs diff 语义）
    if (setClauses.length === 0) {
      return this.#taskJson(this.#requireTaskRow(current.id));
    }

    return this.#transaction(() => {
      // labels 变更 → 与项目标签库合并去重回写（对齐 db.rs）
      if (changes.labels !== undefined && JSON.stringify(changes.labels) !== JSON.stringify(before.labels)) {
        const catalogJson = this.#db
          .prepare("SELECT labels FROM projects WHERE id = ?")
          .get(current.project_id).labels;
        const catalog = this.#mergeLabels(this.#parseJsonArray(catalogJson), changes.labels);
        this.#db
          .prepare("UPDATE projects SET labels = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(catalog), new Date().toISOString(), current.project_id);
      }

      const timestamp = new Date().toISOString();
      const sql = `UPDATE tasks SET ${setClauses.join(", ")}, version = version + 1, updated_at = ?
                   WHERE id = ? AND version = ?`;
      const updated = this.#db.prepare(sql).run(...params, timestamp, current.id, version);
      if (updated.changes !== 1) {
        throw new ApiError(409, "VERSION_CONFLICT", VERSION_CONFLICT_MESSAGE);
      }
      if (activityChanges.length > 0) {
        this.#insertActivity(current.id, actor, activityChanges, timestamp);
      }
      return this.#taskJson(this.#requireTaskRow(current.id));
    });
  }

  /**
   * 流转任务。调用点：db.moveTask(id, version, status, sortOrder, threadId, binding, actor)。
   * sortOrder 缺省按上游惯例（状态变化→min−1000；未变→max+1000）；
   * 状态实际变化时写活动流；thread 绑定列随迁移重置（对齐 db.rs #move_task）。
   */
  moveTask(taskId, version, status, sortOrder, threadId, binding, actor) {
    if (!isTaskStatus(status)) {
      throw new ApiError(400, "INVALID_FIELD", `Invalid status: ${status}`);
    }
    const current = this.#requireTaskRow(taskId);
    if (current.version !== version) {
      throw new ApiError(409, "VERSION_CONFLICT", VERSION_CONFLICT_MESSAGE);
    }
    if (current.archived_at !== null) {
      throw new ApiError(400, "TASK_ARCHIVED", "Archived tasks cannot be moved; restore the task first");
    }

    // sortOrder 缺省逻辑：状态变化 → 目标状态最小值 − 1000；未变 → 当前状态最大值 + 1000
    let nextSortOrder = sortOrder;
    if (nextSortOrder === undefined || nextSortOrder === null) {
      if (status !== current.status) {
        const minimum = this.#db
          .prepare(
            `SELECT MIN(sort_order) AS minimum FROM tasks
             WHERE project_id = ? AND status = ? AND archived_at IS NULL AND id != ?`,
          )
          .get(current.project_id, status, current.id).minimum;
        nextSortOrder = minimum === null ? 1000 : minimum - 1000;
      } else {
        const maximum = this.#db
          .prepare(
            `SELECT COALESCE(MAX(sort_order), 0) AS maximum FROM tasks
             WHERE project_id = ? AND status = ? AND archived_at IS NULL AND id != ?`,
          )
          .get(current.project_id, status, current.id).maximum;
        nextSortOrder = maximum + 1000;
      }
    }

    const timestamp = new Date().toISOString();
    return this.#transaction(() => {
      const updated = this.#db
        .prepare(
          `UPDATE tasks
           SET status = ?, sort_order = ?, thread_id = ?,
               thread_codex_project_id = NULL, thread_codex_project_kind = NULL,
               thread_codex_host_id = NULL, thread_workspace_path = NULL,
               version = version + 1, updated_at = ?
           WHERE id = ? AND version = ?`,
        )
        .run(status, nextSortOrder, binding === undefined ? (threadId ?? current.thread_id) : threadId, timestamp, current.id, version);
      if (updated.changes !== 1) {
        throw new ApiError(409, "VERSION_CONFLICT", VERSION_CONFLICT_MESSAGE);
      }
      // 状态实际变化时记录活动流（挂件详情读取）
      if (status !== current.status) {
        this.#insertActivity(current.id, actor, [{ field: "status", before: current.status, after: status }], timestamp);
      }
      return this.#taskJson(this.#requireTaskRow(current.id));
    });
  }

  /** 归档任务。调用点：db.archiveTask(id, version, threadId, binding, actor) */
  archiveTask(taskId, version, threadId, binding, actor) {
    const current = this.#requireTaskRow(taskId);
    if (current.version !== version) {
      throw new ApiError(409, "VERSION_CONFLICT", VERSION_CONFLICT_MESSAGE);
    }
    const timestamp = new Date().toISOString();
    return this.#transaction(() => {
      const updated = this.#db
        .prepare(
          "UPDATE tasks SET archived_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?",
        )
        .run(timestamp, timestamp, current.id, version);
      if (updated.changes !== 1) {
        throw new ApiError(409, "VERSION_CONFLICT", VERSION_CONFLICT_MESSAGE);
      }
      this.#insertActivity(current.id, actor, [{ field: "archivedAt", before: current.archived_at, after: timestamp }], timestamp);
      return this.#taskJson(this.#requireTaskRow(current.id));
    });
  }

  /** 恢复归档。调用点：db.restoreTask(id, version, threadId, binding, actor)；仅已归档任务可恢复 */
  restoreTask(taskId, version, threadId, binding, actor) {
    const current = this.#requireTaskRow(taskId);
    if (current.version !== version) {
      throw new ApiError(409, "VERSION_CONFLICT", VERSION_CONFLICT_MESSAGE);
    }
    if (current.archived_at === null) {
      throw new ApiError(400, "TASK_NOT_ARCHIVED", "Only archived tasks can be restored");
    }
    const timestamp = new Date().toISOString();
    return this.#transaction(() => {
      const updated = this.#db
        .prepare(
          "UPDATE tasks SET archived_at = NULL, version = version + 1, updated_at = ? WHERE id = ? AND version = ?",
        )
        .run(timestamp, current.id, version);
      if (updated.changes !== 1) {
        throw new ApiError(409, "VERSION_CONFLICT", VERSION_CONFLICT_MESSAGE);
      }
      this.#insertActivity(current.id, actor, [{ field: "archivedAt", before: current.archived_at, after: null }], timestamp);
      return this.#taskJson(this.#requireTaskRow(current.id));
    });
  }

  /* ============================================================
   * 任务关联（issue relation add/remove；写语义对齐 db.rs #add_relation/#remove_relation）
   * ============================================================ */

  /**
   * 建立关联。调用点：db.addTaskRelation(id, version, type, relatedId, threadId, threadBinding, actor)。
   * 端点规范化/自关联拒绝/parent 环检测/单父替换逐字对齐 db.rs；成功后 touch 双方
   * （version+1 + updated_at）；返回 {task, relatedTask}（输出契约对齐上游 addTaskRelation）。
   * thread/binding/actor 仅为对齐类内写方法签名保留（db.rs 关联路径不写 thread/活动流）。
   */
  addTaskRelation(id, version, type, relatedId, threadId, threadBinding, actor) {
    if (id === relatedId) {
      throw new ApiError(400, "INVALID_FIELD", "不能与自身建立关联");
    }
    const task = this.#requireTaskRow(id);
    const related = this.#requireTaskRow(relatedId);
    if (task.version !== version) {
      throw new ApiError(409, "VERSION_CONFLICT", VERSION_CONFLICT_MESSAGE);
    }
    const { relationType, sourceTaskId, targetTaskId } = this.#relationEndpoints(type, task.id, related.id);

    // parent 环检测：从 related 沿 parent（child→parent）向上最多 100 跳，祖先链含 task 即拒绝
    if (relationType === "parent") {
      let cursor = related.id;
      for (let hops = 0; hops < 100; hops += 1) {
        const parent = this.#db
          .prepare(
            "SELECT source_task_id FROM task_relations WHERE relation_type = 'parent' AND target_task_id = ?",
          )
          .get(cursor);
        if (parent === undefined) break;
        if (parent.source_task_id === task.id) {
          throw new ApiError(400, "INVALID_FIELD", "不能创建循环的父子关联");
        }
        cursor = parent.source_task_id;
      }
    }

    return this.#transaction(() => {
      const timestamp = new Date().toISOString();
      if (relationType === "parent") {
        // 单父约束：替换该子任务已有 parent（对齐 db.rs / 上游）
        this.#db
          .prepare("DELETE FROM task_relations WHERE relation_type = 'parent' AND target_task_id = ?")
          .run(targetTaskId);
      } else {
        const exists = this.#db
          .prepare(
            "SELECT 1 FROM task_relations WHERE relation_type = ? AND source_task_id = ? AND target_task_id = ?",
          )
          .get(relationType, sourceTaskId, targetTaskId);
        if (exists) {
          throw new ApiError(409, "RELATION_EXISTS", "该关联已存在");
        }
      }
      this.#db
        .prepare(
          "INSERT INTO task_relations (relation_type, source_task_id, target_task_id, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(relationType, sourceTaskId, targetTaskId, timestamp);
      // touch 双方（对齐 db.rs #add_relation；上游 #touchTask 同义）
      for (const taskId of [task.id, related.id]) {
        this.#db
          .prepare("UPDATE tasks SET version = version + 1, updated_at = ? WHERE id = ?")
          .run(timestamp, taskId);
      }
      return { task: this.getTask(task.id), relatedTask: this.getTask(related.id) };
    });
  }

  /**
   * 移除关联。调用点：db.removeTaskRelation(id, version, type, relatedId, threadId, threadBinding, actor)。
   * 端点规范化同上；DELETE 0 行报 RELATION_NOT_FOUND；成功只 touch id 一方（对齐 db.rs #remove_relation，
   * 上游同：remove 不 touch related）。返回 {task, relatedTask}。
   */
  removeTaskRelation(id, version, type, relatedId, threadId, threadBinding, actor) {
    const task = this.#requireTaskRow(id);
    if (task.version !== version) {
      throw new ApiError(409, "VERSION_CONFLICT", VERSION_CONFLICT_MESSAGE);
    }
    // related 存在性不强制（对齐 db.rs：remove 只校验 id 方）；存在时归一到真实 id（支持 identifier）
    const relatedTaskId = this.#taskRow(relatedId)?.id ?? relatedId;
    const { relationType, sourceTaskId, targetTaskId } = this.#relationEndpoints(type, task.id, relatedTaskId);
    return this.#transaction(() => {
      const deleted = this.#db
        .prepare(
          "DELETE FROM task_relations WHERE relation_type = ? AND source_task_id = ? AND target_task_id = ?",
        )
        .run(relationType, sourceTaskId, targetTaskId);
      if (deleted.changes !== 1) {
        throw new ApiError(404, "RELATION_NOT_FOUND", "该关联不存在");
      }
      const timestamp = new Date().toISOString();
      this.#db
        .prepare("UPDATE tasks SET version = version + 1, updated_at = ? WHERE id = ?")
        .run(timestamp, task.id);
      return { task: this.getTask(task.id), relatedTask: this.getTask(relatedTaskId) };
    });
  }

  /** 关联端点规范化：对齐 db.rs #relation_endpoints / 上游 #relationEndpoints */
  #relationEndpoints(type, taskId, relatedTaskId) {
    if (type === "parent") {
      return { relationType: "parent", sourceTaskId: relatedTaskId, targetTaskId: taskId };
    }
    if (type === "blocks") {
      return { relationType: "blocks", sourceTaskId: taskId, targetTaskId: relatedTaskId };
    }
    if (type === "blocked_by") {
      return { relationType: "blocks", sourceTaskId: relatedTaskId, targetTaskId: taskId };
    }
    if (type === "related") {
      const [sourceTaskId, targetTaskId] = taskId < relatedTaskId
        ? [taskId, relatedTaskId]
        : [relatedTaskId, taskId];
      return { relationType: "related", sourceTaskId, targetTaskId };
    }
    throw new ApiError(400, "INVALID_FIELD", `非法关联类型：${type}`);
  }

  /* ============================================================
   * 评论
   * ============================================================ */

  /** 发表评论。调用点：db.createComment(taskId, { body, threadId, actor })——不写活动流 */
  createComment(taskId, { body, threadId, actor }) {
    const task = this.#requireTaskRow(taskId);
    if (typeof body !== "string" || body.trim().length === 0) {
      throw new ApiError(400, "INVALID_FIELD", "'body' cannot be empty");
    }
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const author = actor ?? {};
    const trimmed = body.trim();
    this.#db
      .prepare(
        `INSERT INTO comments (
           id, task_id, body, thread_id, thread_codex_project_id, thread_codex_project_kind,
           thread_codex_host_id, thread_workspace_path,
           author_type, author_id, author_name, author_avatar_url,
           version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        id,
        task.id,
        trimmed,
        threadId ?? null,
        author.type ?? "user",
        author.id ?? "local-user",
        author.name ?? "本地用户",
        author.avatarUrl ?? null,
        timestamp,
        timestamp,
      );
    return this.#commentJson(this.#commentRow(id));
  }

  /** 更新评论。调用点：db.updateComment(commentId, version, body, threadId, actor) */
  updateComment(commentId, version, body, threadId, actor) {
    const current = this.#commentRow(commentId);
    if (!current) {
      throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${commentId}' does not exist`);
    }
    if (typeof body !== "string" || body.trim().length === 0) {
      throw new ApiError(400, "INVALID_FIELD", "'body' cannot be empty");
    }
    const timestamp = new Date().toISOString();
    const updated = this.#db
      .prepare("UPDATE comments SET body = ?, thread_id = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?")
      .run(body.trim(), threadId ?? current.thread_id, timestamp, current.id, version);
    if (updated.changes !== 1) {
      throw new ApiError(409, "VERSION_CONFLICT", VERSION_CONFLICT_MESSAGE);
    }
    return this.#commentJson(this.#commentRow(commentId));
  }

  /** 删除评论。调用点：db.deleteComment(commentId, version) */
  deleteComment(commentId, version) {
    const current = this.#commentRow(commentId);
    if (!current) {
      throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${commentId}' does not exist`);
    }
    const deleted = this.#db.prepare("DELETE FROM comments WHERE id = ? AND version = ?").run(current.id, version);
    if (deleted.changes !== 1) {
      throw new ApiError(409, "VERSION_CONFLICT", VERSION_CONFLICT_MESSAGE);
    }
  }

  /** 评论列表：tiebreaker 用 rowid（插入序=时间序，确定性；与挂件 issue_detail 同偏离） */
  listComments(taskId) {
    const task = this.#requireTaskRow(taskId);
    const rows = this.#db
      .prepare("SELECT * FROM comments WHERE task_id = ? ORDER BY created_at, rowid")
      .all(task.id);
    return rows.map((row) => this.#commentJson(row));
  }

  /** 评论详情（attachment upload --comment 前置校验等）：不存在返回 null */
  getComment(commentId) {
    const row = this.#commentRow(commentId);
    return row ? this.#commentJson(row) : null;
  }

  #commentRow(commentId) {
    return this.#db.prepare("SELECT * FROM comments WHERE id = ?").get(commentId);
  }

  #commentJson(row) {
    return {
      id: row.id,
      taskId: row.task_id,
      body: row.body,
      threadId: row.thread_id,
      authorType: row.author_type,
      authorId: row.author_id,
      authorName: row.author_name,
      authorAvatarUrl: row.author_avatar_url,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /* ============================================================
   * 附件（纯 DB：元数据入库/查询；内容磁盘读写由 CLI 层负责，
   * 与类内既有职责划分一致——本层除构造器建库目录外不触碰文件系统）
   * ============================================================ */

  /**
   * 附件元数据入库。调用点：db.createAttachment({ id, taskId, commentId, filename,
   * contentType, size, createdAt })。id/createdAt 由 CLI 生成（磁盘文件名 = id，
   * 须先写盘后入库，顺序对齐 db.rs #upload_attachment）。
   * 校验对齐 db.rs：--task 时任务必须存在（TASK_NOT_FOUND）；--comment 时评论必须
   * 存在（COMMENT_NOT_FOUND）且 task_id 落评论所属任务；文件名非空 ≤255（INVALID_FIELD）。
   */
  createAttachment({ id, taskId, commentId, filename, contentType, size, createdAt }) {
    if (typeof filename !== "string" || filename.length === 0 || filename.length > 255) {
      throw new ApiError(400, "INVALID_FIELD", "'filename' must be a non-empty string of at most 255 characters");
    }
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new ApiError(400, "INVALID_FIELD", "'size' must be a non-negative integer");
    }
    let ownerTaskId;
    let ownerCommentId = null;
    if (commentId !== undefined && commentId !== null) {
      const comment = this.#commentRow(commentId);
      if (!comment) {
        throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${commentId}' does not exist`);
      }
      ownerTaskId = comment.task_id;
      ownerCommentId = comment.id;
    } else {
      ownerTaskId = this.#requireTaskRow(taskId).id;
    }
    const timestamp = createdAt ?? new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO attachments (id, task_id, comment_id, filename, content_type, size, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, ownerTaskId, ownerCommentId, filename, contentType, size, timestamp);
    return { id, filename, contentType, size, createdAt: timestamp };
  }

  /** 附件元数据查询：不存在返回 null（磁盘文件是否在由 CLI 层核查） */
  getAttachment(attachmentId) {
    const row = this.#db
      .prepare("SELECT id, task_id, comment_id, filename, content_type, size, created_at FROM attachments WHERE id = ?")
      .get(attachmentId);
    if (!row) return null;
    return {
      id: row.id,
      taskId: row.task_id,
      commentId: row.comment_id,
      filename: row.filename,
      contentType: row.content_type,
      size: row.size,
      createdAt: row.created_at,
    };
  }

  /* ============================================================
   * 活动流
   * ============================================================ */

  /**
   * 活动流列表：listActivities(taskId, sinceId?)。
   * sinceId 为游标——只返回该活动之后（rowid 更大）的记录；未知 sinceId 视为无游标。
   * ORDER BY created_at, rowid（同毫秒事件的稳定顺序，与挂件一致）。
   */
  listActivities(taskId, sinceId) {
    const task = this.#requireTaskRow(taskId);
    const rows = sinceId
      ? this.#db
          .prepare(
            `SELECT * FROM task_activities
             WHERE task_id = ? AND rowid > COALESCE((SELECT rowid FROM task_activities WHERE id = ?), -1)
             ORDER BY created_at, rowid`,
          )
          .all(task.id, sinceId)
      : this.#db.prepare("SELECT * FROM task_activities WHERE task_id = ? ORDER BY created_at, rowid").all(task.id);
    return rows.map((row) => this.#activityJson(row));
  }

  /**
   * 活动流聚合读取（AI 回执闭环 · taskctl activity list 命令轨）：
   * 按 threadId 圈定会话名下全部任务的变更流（含人机双方）；threadId 缺省则跨全部任务。
   * sinceId 为全局游标——只返回该活动之后（rowid 更大）的记录；未知 sinceId 视为无游标。
   * 排序语义参照 db.rs issue_detail 活动流查询（created_at + rowid 稳定 tiebreaker）；
   * 附带 taskIdentifier / taskTitle 便于在跨任务流中定位变更对象。
   */
  listActivityFeed(threadId, sinceId) {
    const clauses = [];
    const params = [];
    if (threadId !== undefined && threadId !== null && threadId !== "") {
      clauses.push("t.thread_id = ?");
      params.push(threadId);
    }
    if (sinceId !== undefined && sinceId !== null && sinceId !== "") {
      clauses.push("a.rowid > COALESCE((SELECT rowid FROM task_activities WHERE id = ?), -1)");
      params.push(sinceId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.#db
      .prepare(
        `SELECT a.*, t.identifier AS task_identifier, t.title AS task_title
         FROM task_activities a
         JOIN tasks t ON t.id = a.task_id
         ${where}
         ORDER BY a.created_at, a.rowid`,
      )
      .all(...params);
    return rows.map((row) => ({
      ...this.#activityJson(row),
      taskIdentifier: row.task_identifier,
      taskTitle: row.task_title,
    }));
  }

  #activityJson(row) {
    let changes;
    try {
      changes = JSON.parse(row.changes);
    } catch {
      changes = [];
    }
    return {
      id: row.id,
      taskId: row.task_id,
      actorType: row.actor_type,
      actorId: row.actor_id,
      actorName: row.actor_name,
      actorAvatarUrl: row.actor_avatar_url,
      changes,
      createdAt: row.created_at,
    };
  }

  /* ============================================================
   * 内部工具
   * ============================================================ */

  /** 活动流写入：actor/changes 与 db.rs 同构（actor_type/actor_id/actor_name + changes JSON） */
  #insertActivity(taskId, actor, changes, timestamp) {
    const resolved = actor ?? {};
    this.#db
      .prepare(
        `INSERT INTO task_activities (
           id, task_id, actor_type, actor_id, actor_name, actor_avatar_url, changes, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        taskId,
        resolved.type ?? "user",
        resolved.id ?? "local-user",
        resolved.name ?? "本地用户",
        resolved.avatarUrl ?? null,
        JSON.stringify(changes),
        timestamp,
      );
  }

  /** BEGIN IMMEDIATE 事务包装：抛错回滚，成功提交（对齐 db.rs 各写路径） */
  #transaction(body) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = body();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // 连接已失效时回滚失败可容忍
      }
      throw error;
    }
  }

  #parseJsonArray(text) {
    if (text === null || text === undefined) return [];
    try {
      const value = JSON.parse(text);
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  /** 标签合并：保留 catalog 顺序，追加 catalog 中不存在的新标签 */
  #mergeLabels(catalog, labels) {
    const merged = [...catalog];
    for (const label of labels ?? []) {
      if (!merged.includes(label)) {
        merged.push(label);
      }
    }
    return merged;
  }
}

/* ==== identifier 前缀：项目首个任务 identifier 去尾部 -数字，否则项目 id 大写去非字母数字截 12（对齐 db.rs）==== */
function identifierPrefix(firstIdentifier, projectId) {
  if (typeof firstIdentifier === "string" && firstIdentifier.length > 0) {
    const index = firstIdentifier.lastIndexOf("-");
    if (index > 0 && index < firstIdentifier.length - 1) {
      const head = firstIdentifier.slice(0, index);
      const tail = firstIdentifier.slice(index + 1);
      if (head.length > 0 && tail.length > 0 && /^\d+$/.test(tail)) {
        return head;
      }
    }
  }
  const prefix = projectId
    .toUpperCase()
    .split("")
    .filter((char) => /[A-Z0-9]/.test(char))
    .join("")
    .slice(0, 12);
  return prefix.length > 0 ? prefix : "TASK";
}
