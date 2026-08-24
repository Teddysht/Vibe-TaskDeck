#!/usr/bin/env node
/**
 * taskctl 本地模式：绕过 HTTP 服务，直连 SQLite（复用 upstream 的 TaskboardDatabase）。
 *
 * 输出契约与 upstream/cli/taskctl.mjs 完全一致：
 *   · 成功：stdout 一行 JSON { ...result, schemaVersion: 2 }
 *   · 失败：stderr 一行 JSON { schemaVersion, error: { code, message[, details] } }
 *   · 退出码：0 成功 / 2 用法错误 / 3 环境不可用 / 4 API 错误 / 5 版本冲突(409)
 *
 * 数据库路径解析与挂件 Rust 数据层一致：
 *   CODEX_TASKBOARD_DATA_DIR > %APPDATA%\dashi-taskboard\taskboard.sqlite
 * （taskboard.py 会显式设置该变量指向 <repo>/.data，与 server 模式同库互通）
 *
 * 支持子集：project list/create、issue list/get/create/update/move/archive/restore、
 * comment list/add/update/delete、context current。
 * 不支持（需 server 模式）：cloud、project map、issue relation、attachment。
 */

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TaskboardDatabase, ApiError } from "../upstream/server/database.mjs";
import {
  DEFAULT_PROJECT_ID,
  TASK_STATUSES,
  isTaskPriority,
  isTaskStatus,
} from "../upstream/shared/domain.mjs";

export const SCHEMA_VERSION = 2;

const BOOLEAN_OPTIONS = new Set(["json", "clear-binding-thread"]);
const GLOBAL_OPTIONS = new Set(["runtime-file"]);

// 与 upstream COMMAND_OPTIONS 中本地模式支持的子集保持一致（选项集合逐字相同）
const COMMAND_OPTIONS = new Map([
  ["project list", new Set(["json"])],
  ["project create", new Set(["id", "name", "workspace-path", "json"])],
  ["issue list", new Set(["project", "status", "archived", "json"])],
  ["issue get", new Set(["json"])],
  [
    "issue create",
    new Set([
      "project",
      "title",
      "description",
      "description-file",
      "status",
      "priority",
      "labels",
      "thread-id",
      "git-branch",
      "worktree-path",
      "worktree-branch",
      "start-date",
      "due-date",
      "recurrence-interval",
      "recurrence-unit",
      "json",
    ]),
  ],
  [
    "issue update",
    new Set([
      "project",
      "title",
      "description",
      "description-file",
      "status",
      "priority",
      "labels",
      "thread-id",
      "git-branch",
      "worktree-path",
      "worktree-branch",
      "start-date",
      "due-date",
      "recurrence-interval",
      "recurrence-unit",
      "if-version",
      "json",
    ]),
  ],
  ["issue move", new Set([
    "status",
    "thread-id",
    "binding-thread-id",
    "binding-codex-project-id",
    "binding-codex-project-kind",
    "binding-codex-host-id",
    "binding-workspace-path",
    "clear-binding-thread",
    "if-version",
    "json",
  ])],
  ["issue archive", new Set(["thread-id", "if-version", "json"])],
  ["issue restore", new Set(["thread-id", "if-version", "json"])],
  ["comment list", new Set(["json"])],
  ["comment add", new Set(["body", "thread-id", "json"])],
  ["comment update", new Set(["body", "thread-id", "if-version", "json"])],
  ["comment delete", new Set(["thread-id", "if-version", "json"])],
  ["context current", new Set(["cwd", "json"])],
]);

// 本地模式不支持的命令：给出明确指引而非笼统 usage 错误
const UNSUPPORTED_COMMANDS = new Set([
  "project map",
  "cloud login",
  "cloud status",
  "cloud logout",
  "issue relation",
  "attachment download",
  "attachment upload",
]);

// 与 HTTP 模式 x-taskboard-client: taskctl 头的 actor 效果一致（app.mjs CODEX_AGENT_ACTOR）
const CODEX_AGENT_ACTOR = {
  type: "agent",
  id: "codex-agent",
  name: "Codex Agent",
  avatarUrl: null,
};

const PROJECT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

class TaskctlError extends Error {
  constructor(message, { code = "TASKCTL_ERROR", exitCode = 2, details } = {}) {
    super(message);
    this.name = "TaskctlError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

export function parseArgs(argv) {
  if (!Array.isArray(argv)) {
    throw new TypeError("argv must be an array");
  }

  const positionals = [];
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const equalsIndex = token.indexOf("=");
    const name = token.slice(2, equalsIndex === -1 ? undefined : equalsIndex);
    if (!name) {
      throw usageError("Invalid empty option");
    }

    if (Object.hasOwn(options, name)) {
      throw usageError(`Option --${name} may only be specified once`);
    }

    if (BOOLEAN_OPTIONS.has(name)) {
      if (equalsIndex !== -1) {
        throw usageError(`Option --${name} does not accept a value`);
      }
      options[name] = true;
      continue;
    }

    if (equalsIndex !== -1) {
      options[name] = token.slice(equalsIndex + 1);
      continue;
    }

    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw usageError(`Option --${name} requires a value`);
    }
    options[name] = value;
    index += 1;
  }

  return {
    resource: positionals[0],
    action: positionals[1],
    operands: positionals.slice(2),
    options,
  };
}

export async function main(argv = process.argv.slice(2), overrides = {}) {
  const stdout = overrides.stdout ?? process.stdout;
  const stderr = overrides.stderr ?? process.stderr;

  try {
    const parsed = parseArgs(argv);
    const result = execute(parsed, overrides);
    writeJson(stdout, { ...result, schemaVersion: SCHEMA_VERSION });
    return 0;
  } catch (error) {
    const normalized = normalizeError(error);
    const payload = {
      schemaVersion: SCHEMA_VERSION,
      error: {
        code: normalized.code,
        message: normalized.message,
      },
    };
    if (normalized.details !== undefined) {
      payload.error.details = normalized.details;
    }
    writeJson(stderr, payload);
    return normalized.exitCode;
  }
}

function execute(parsed, overrides) {
  const command = `${parsed.resource ?? ""} ${parsed.action ?? ""}`.trim();
  if (UNSUPPORTED_COMMANDS.has(command)) {
    throw new TaskctlError(
      `Local mode does not support '${command}'. Start the server (taskboard.py start) and use the upstream taskctl.`,
      { code: "UNSUPPORTED_LOCAL", exitCode: 2 },
    );
  }
  const allowedOptions = COMMAND_OPTIONS.get(command);
  if (!allowedOptions) {
    throw usageError(
      "Expected one of: project list/create, issue list/get/create/update/move/archive/restore, comment list/add/update/delete, context current",
    );
  }
  validateOptions(parsed.options, allowedOptions);

  // 每次调用即开即关：短生命周期 CLI，避免与挂件长连接争抢 WAL 写锁
  const db = new TaskboardDatabase(resolveDbFile(overrides));
  try {
    switch (command) {
      case "project list":
        expectOperandCount(parsed, 0);
        return projectList(db);
      case "project create":
        expectOperandCount(parsed, 0);
        return projectCreate(db, parsed.options, overrides);
      case "issue list":
        expectOperandCount(parsed, 0);
        return issueList(db, parsed.options);
      case "issue get":
        expectOperandCount(parsed, 1);
        return issueGet(db, parsed.operands[0]);
      case "issue create":
        expectOperandCount(parsed, 0);
        return issueCreate(db, parsed.options, overrides);
      case "issue update":
        expectOperandCount(parsed, 1);
        return issueUpdate(db, parsed.operands[0], parsed.options, overrides);
      case "issue move":
        expectOperandCount(parsed, 1);
        return issueMove(db, parsed.operands[0], parsed.options, overrides);
      case "issue archive":
        expectOperandCount(parsed, 1);
        return issueArchive(db, parsed.operands[0], parsed.options, overrides, "archive");
      case "issue restore":
        expectOperandCount(parsed, 1);
        return issueArchive(db, parsed.operands[0], parsed.options, overrides, "restore");
      case "comment list":
        expectOperandCount(parsed, 1);
        return { comments: db.listComments(requireIssueId(parsed.operands[0])) };
      case "comment add":
        expectOperandCount(parsed, 1);
        return commentAdd(db, parsed.operands[0], parsed.options, overrides);
      case "comment update":
        expectOperandCount(parsed, 1);
        return commentUpdate(db, parsed.operands[0], parsed.options, overrides);
      case "comment delete":
        expectOperandCount(parsed, 1);
        return commentDelete(db, parsed.operands[0], parsed.options, overrides);
      case "context current":
        expectOperandCount(parsed, 0);
        return currentContext(db, parsed.options, overrides);
      default:
        throw usageError(`Unsupported command: ${command}`);
    }
  } finally {
    db.close();
  }
}

// ============================================================
// 数据库定位
// ============================================================

function resolveDbFile(overrides) {
  const env = overrides.env ?? process.env;
  const configured = env.CODEX_TASKBOARD_DATA_DIR?.trim();
  if (configured) {
    return path.resolve(configured, "taskboard.sqlite");
  }
  const appdata = env.APPDATA?.trim();
  if (appdata) {
    return path.resolve(appdata, "dashi-taskboard", "taskboard.sqlite");
  }
  throw new TaskctlError(
    "Cannot locate the taskboard data directory. Set CODEX_TASKBOARD_DATA_DIR.",
    { code: "SERVICE_UNAVAILABLE", exitCode: 3 },
  );
}

// ============================================================
// 命令实现（与 HTTP 路由层语义对齐）
// ============================================================

function projectList(db) {
  const projects = db.listProjects().map((project) => ({
    ...project,
    // 对齐路由层：local 项目的 workspacePath 强制置 null（app.mjs:2213-2215）
    workspacePath: project.id === DEFAULT_PROJECT_ID ? null : project.workspacePath,
  }));
  return { projects };
}

function projectCreate(db, options, overrides) {
  const name = requiredOption(options, "name");
  assertStringLength(name, "name", 120);
  const id = validateProjectId(options.id ?? slugify(name));
  if (!id) {
    throw apiError(400, "INVALID_FIELD", "Project name must contain at least one letter or number when 'id' is omitted");
  }
  const workspacePath = options["workspace-path"] === undefined
    ? null
    : resolveInputPath(options["workspace-path"], overrides);
  return { project: db.createProject({ id, name, workspacePath }) };
}

function issueList(db, options) {
  if (options.status !== undefined) {
    assertStatus(options.status);
  }
  if (options.archived !== undefined && !["true", "false", "all"].includes(options.archived)) {
    throw usageError("--archived must be true, false, or all");
  }
  // 对齐路由默认值：未传 --archived 时只看未归档任务（app.mjs parseTaskFilters）
  const archived = options.archived ?? "false";
  return {
    tasks: db.listTasks({
      projectId: options.project,
      status: options.status,
      archived: archived === "all" ? undefined : archived,
    }),
  };
}

function issueGet(db, taskId) {
  const task = db.getTask(requireIssueId(taskId));
  if (!task) {
    throw apiError(404, "TASK_NOT_FOUND", `Task '${taskId}' does not exist`);
  }
  return { task };
}

function issueCreate(db, options, overrides) {
  const status = options.status ?? "backlog";
  const priority = options.priority ?? "none";
  assertStatus(status);
  assertPriority(priority);

  const projectId = requiredOption(options, "project");
  const title = requiredOption(options, "title");
  assertStringLength(title, "title", 240);
  if (title.length === 0) {
    throw apiError(400, "INVALID_FIELD", "'title' cannot be empty");
  }

  const developmentContext = developmentContextFromOptions(options, overrides);
  const recurrence = recurrenceFromOptions(options);
  if (recurrence && !options["due-date"]) {
    throw apiError(400, "INVALID_FIELD", "A recurring issue requires a due date");
  }
  const threadId = resolveThreadId(options, overrides);
  return {
    task: db.createTask({
      projectId,
      title,
      description: resolveDescriptionSync(options),
      status,
      priority,
      labels: parseLabels(options.labels),
      threadId,
      // 对齐路由层 parseTaskCreate：可空字段规范化为 null（SQLite 无法绑定 undefined）
      workflowId: null,
      developmentContext: developmentContext ?? null,
      startDate: options["start-date"] ?? null,
      dueDate: options["due-date"] ?? null,
      recurrence: recurrence ?? null,
      actor: CODEX_AGENT_ACTOR,
      assignee: CODEX_AGENT_ACTOR,
    }),
  };
}

function issueUpdate(db, taskId, options, overrides) {
  if (options.status !== undefined) assertStatus(options.status);
  if (options.priority !== undefined) assertPriority(options.priority);
  if (options.title !== undefined) {
    assertStringLength(options.title, "title", 240);
    if (options.title.length === 0) {
      throw apiError(400, "INVALID_FIELD", "'title' cannot be empty");
    }
  }

  const developmentContext = developmentContextFromOptions(options, overrides);
  const recurrence = recurrenceFromOptions(options);
  const threadId = resolveThreadId(options, overrides);
  const changes = {};
  setIfPresent(changes, "projectId", options.project);
  setIfPresent(changes, "title", options.title);
  setIfPresent(changes, "status", options.status);
  setIfPresent(changes, "priority", options.priority);
  setIfPresent(changes, "labels", options.labels === undefined ? undefined : parseLabels(options.labels));
  setIfPresent(changes, "startDate", options["start-date"]);
  setIfPresent(changes, "dueDate", options["due-date"]);
  setIfPresent(changes, "developmentContext", developmentContext);
  setIfPresent(changes, "recurrence", recurrence);
  if (options.description !== undefined || options["description-file"] !== undefined) {
    changes.description = resolveDescriptionSync(options);
  }

  if (Object.keys(changes).length === 0) {
    throw usageError("issue update requires at least one field to update");
  }
  const id = requireIssueId(taskId);
  const version = resolveVersion(db, id, options["if-version"]);
  return { task: db.updateTask(id, version, changes, threadId, undefined, CODEX_AGENT_ACTOR) };
}

function issueMove(db, taskId, options, overrides) {
  const status = requiredOption(options, "status");
  assertStatus(status);
  const threadId = resolveThreadId(options, overrides);
  const id = requireIssueId(taskId);
  const version = resolveVersion(db, id, options["if-version"]);
  return { task: db.moveTask(id, version, status, undefined, threadId, undefined, CODEX_AGENT_ACTOR) };
}

function issueArchive(db, taskId, options, overrides, action) {
  const threadId = resolveThreadId(options, overrides);
  const id = requireIssueId(taskId);
  const version = resolveVersion(db, id, options["if-version"]);
  const task = action === "archive"
    ? db.archiveTask(id, version, threadId, undefined, CODEX_AGENT_ACTOR)
    : db.restoreTask(id, version, threadId, undefined, CODEX_AGENT_ACTOR);
  return { task };
}

function commentAdd(db, taskId, options, overrides) {
  const threadId = resolveThreadId(options, overrides);
  return {
    comment: db.createComment(requireIssueId(taskId), {
      body: requiredOption(options, "body"),
      threadId,
      actor: CODEX_AGENT_ACTOR,
    }),
  };
}

function commentUpdate(db, commentId, options, overrides) {
  const threadId = resolveThreadId(options, overrides);
  const version = explicitVersion(options["if-version"]);
  return {
    comment: db.updateComment(requireCommentId(commentId), version, requiredOption(options, "body"), threadId, undefined),
  };
}

function commentDelete(db, commentId, options, overrides) {
  resolveThreadId(options, overrides); // 保持与上游一致：删除也要 thread-id
  const version = explicitVersion(options["if-version"]);
  db.deleteComment(requireCommentId(commentId), version);
  // 对齐 HTTP 204 空响应：taskctl 原样输出仅含 schemaVersion 的 JSON
  return {};
}

function currentContext(db, options, overrides) {
  const cwd = path.resolve(options.cwd ?? overrides.cwd ?? process.cwd());
  const projects = db.listProjects();
  const matchingProjects = projects
    .filter((candidate) => workspaceContains(candidate?.workspacePath, cwd))
    .sort((left, right) => right.workspacePath.length - left.workspacePath.length);
  const project = matchingProjects[0]
    ?? projects.find((candidate) => candidate?.id === DEFAULT_PROJECT_ID)
    ?? projects[0]
    ?? null;
  return { cwd, project };
}

// ============================================================
// 共用工具（与 upstream taskctl 语义一致）
// ============================================================

function resolveVersion(db, taskId, rawVersion) {
  if (rawVersion !== undefined) {
    const version = Number(rawVersion);
    if (!Number.isSafeInteger(version) || version < 1) {
      throw usageError("--if-version must be a positive integer");
    }
    return version;
  }

  const task = db.getTask(taskId);
  const version = task?.version;
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new TaskctlError("Taskboard service returned a task without a valid version", {
      code: "INVALID_RESPONSE",
      exitCode: 4,
    });
  }
  return version;
}

function resolveThreadId(options, overrides) {
  const env = overrides.env ?? process.env;
  const value = options["thread-id"] ?? env.CODEX_THREAD_ID;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw usageError("Codex conversation attribution requires --thread-id or CODEX_THREAD_ID");
  }
  const threadId = value.trim();
  if (threadId.length > 256) {
    throw usageError("--thread-id and CODEX_THREAD_ID cannot exceed 256 characters");
  }
  return threadId;
}

function resolveDescriptionSync(options) {
  if (options.description !== undefined && options["description-file"] !== undefined) {
    throw usageError("Use either --description or --description-file, not both");
  }
  if (options["description-file"] === undefined) {
    return options.description ?? "";
  }
  // description-file 为异步读取，但 CLI 单命令生命周期内同步等待等价；
  // 保留 upstream 的错误语义。
  try {
    return require("node:fs").readFileSync(options["description-file"], "utf8");
  } catch (error) {
    throw new TaskctlError(`Cannot read description file: ${options["description-file"]}`, {
      code: "FILE_READ_FAILED",
      exitCode: 2,
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseLabels(rawLabels) {
  if (rawLabels === undefined || rawLabels === "") return [];
  return [...new Set(rawLabels.split(",").map((label) => label.trim()).filter(Boolean))];
}

function developmentContextFromOptions(options, overrides) {
  const branch = options["git-branch"];
  const worktreePath = options["worktree-path"];
  const worktreeBranch = options["worktree-branch"];
  if (branch !== undefined && (worktreePath !== undefined || worktreeBranch !== undefined)) {
    throw usageError("Use either --git-branch or --worktree-path/--worktree-branch, not both");
  }
  if (worktreeBranch !== undefined && worktreePath === undefined) {
    throw usageError("--worktree-branch requires --worktree-path");
  }
  if (branch !== undefined) return { type: "branch", branch };
  if (worktreePath !== undefined) {
    return {
      type: "worktree",
      path: resolveInputPath(worktreePath, overrides),
      branch: worktreeBranch ?? null,
    };
  }
  return undefined;
}

function recurrenceFromOptions(options) {
  const rawInterval = options["recurrence-interval"];
  const unit = options["recurrence-unit"];
  if (rawInterval === undefined && unit === undefined) return undefined;
  if (rawInterval === undefined || unit === undefined) {
    throw usageError("Use --recurrence-interval and --recurrence-unit together");
  }
  const interval = Number(rawInterval);
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > 365) {
    throw usageError("--recurrence-interval must be an integer from 1 to 365");
  }
  if (!["day", "week", "month", "year"].includes(unit)) {
    throw usageError("--recurrence-unit must be day, week, month, or year");
  }
  return { interval, unit };
}

function workspaceContains(workspacePath, cwd) {
  if (typeof workspacePath !== "string" || workspacePath.length === 0) return false;
  const relative = path.relative(path.resolve(workspacePath), cwd);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function resolveInputPath(value, overrides) {
  return path.resolve(overrides.cwd ?? process.cwd(), value);
}

function requiredOption(options, name) {
  const value = options[name];
  if (value === undefined || value === "") {
    throw usageError(`Missing required option --${name}`);
  }
  return value;
}

function setIfPresent(target, name, value) {
  if (value !== undefined) target[name] = value;
}

function validateOptions(options, allowedOptions) {
  for (const name of Object.keys(options)) {
    if (!allowedOptions.has(name) && !GLOBAL_OPTIONS.has(name)) {
      throw usageError(`Unknown option --${name}`);
    }
  }
}

function expectOperandCount(parsed, expected) {
  if (parsed.operands.length !== expected) {
    throw usageError(
      expected === 0
        ? `${parsed.resource} ${parsed.action} does not accept positional arguments`
        : `${parsed.resource} ${parsed.action} requires exactly ${expected} positional ${
            expected === 1 ? "argument" : "arguments"
          }`,
    );
  }
}

function assertStatus(status) {
  if (!isTaskStatus(status)) {
    throw usageError(`Invalid status: ${status}. Expected one of: ${TASK_STATUSES.join(", ")}`);
  }
}

function assertPriority(priority) {
  if (!isTaskPriority(priority)) {
    throw usageError(`Invalid priority: ${priority}`);
  }
}

function assertStringLength(value, name, maxLength) {
  if (typeof value !== "string" || value.length > maxLength) {
    throw apiError(400, "INVALID_FIELD", `'${name}' must be a string of at most ${maxLength} characters`);
  }
}

function requireIssueId(taskId) {
  if (!taskId) throw usageError("Missing issue id");
  return taskId;
}

function requireCommentId(commentId) {
  if (!commentId) throw usageError("Missing comment id");
  return commentId;
}

function explicitVersion(rawVersion) {
  if (rawVersion === undefined) throw usageError("Missing required option --if-version");
  const version = Number(rawVersion);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw usageError("--if-version must be a positive integer");
  }
  return version;
}

function validateProjectId(value) {
  if (value !== undefined && !PROJECT_ID_PATTERN.test(value)) {
    throw apiError(400, "INVALID_FIELD", "'id' must be a lowercase slug containing letters, numbers, or hyphens");
  }
  return value;
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

function apiError(status, code, message, details) {
  return new ApiError(status, code, message, details);
}

function normalizeError(error) {
  if (error instanceof TaskctlError) return error;
  if (error instanceof ApiError) {
    return new TaskctlError(error.message, {
      code: error.code,
      exitCode: error.status === 409 ? 5 : 4,
      details: error.details,
    });
  }
  return new TaskctlError(error instanceof Error ? error.message : String(error), {
    code: "INTERNAL_ERROR",
    exitCode: 1,
  });
}

function usageError(message) {
  return new TaskctlError(message, { code: "USAGE_ERROR", exitCode: 2 });
}

function writeJson(stream, payload) {
  stream.write(`${JSON.stringify(payload)}\n`);
}

const entrypoint = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (entrypoint === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
