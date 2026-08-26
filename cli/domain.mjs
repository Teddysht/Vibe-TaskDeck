/* ==== 领域常量与校验（自研版，替换 ../upstream/shared/domain.mjs）====
 *
 * 上游快照不入库且本机已缺失，此处按 cli/taskctl-local.mjs 的用法与
 * widget/src-tauri/src/db.rs 的同名常量反推重建（两处取值逐字一致）：
 *   · TASK_STATUSES：状态数组，顺序对齐看板七列（db.rs:26）
 *   · TASK_PRIORITIES：优先级数组（db.rs:27）
 *   · DEFAULT_PROJECT_ID：默认项目 id（db.rs seed_local_project）
 *   · isTaskStatus / isTaskPriority：CLI 的 assertStatus/assertPriority 校验函数
 */

export const DEFAULT_PROJECT_ID = "local";

/** 任务状态：顺序即看板列顺序（与 Rust 侧 TASK_STATUSES 逐字一致） */
export const TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "canceled",
];

/** 任务优先级（与 Rust 侧 TASK_PRIORITIES 逐字一致） */
export const TASK_PRIORITIES = ["none", "urgent", "high", "medium", "low"];

/** 校验是否为合法任务状态 */
export function isTaskStatus(value) {
  return typeof value === "string" && TASK_STATUSES.includes(value);
}

/** 校验是否为合法任务优先级 */
export function isTaskPriority(value) {
  return typeof value === "string" && TASK_PRIORITIES.includes(value);
}
