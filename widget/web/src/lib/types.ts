/* ============================================================
 * 类型与常量 —— 移植自 config.js（状态枚举与上游 shared/domain.mjs 对齐）
 * ============================================================ */

// 窗口尺寸（mini/large 与 Tauri main.rs 一致；快捷看板已移除——多列看板走全版第二窗口）
export const SIZES = {
  mini: { w: 280, h: 48 },
  large: { w: 360, h: 520 },
} as const;

// 轮转与轮询节奏
export const ROTATE_MS = 5000; // mini 胶囊轮转间隔
export const RETRY_MS = 5000; // 离线重试间隔
export const POLL_OK_MS = 5000; // 在线时后台轮询兜底间隔（感知外部写入的唯一机制）

// 状态枚举（与上游 shared/domain.mjs 保持一致）
export type Status =
  | 'backlog'
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'blocked'
  | 'done'
  | 'canceled';

export const STATUS_ORDER: Status[] = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'blocked',
  'done',
];

export const STATUS_LABEL: Record<string, string> = {
  backlog: '待办池',
  todo: '待处理',
  in_progress: '进行中',
  in_review: '待评审',
  blocked: '阻塞',
  done: '已完成',
  canceled: '已取消',
};

// 轮转优先级排序键（越小越优先展示）
export const ROT_ORDER: Record<string, number> = {
  blocked: 0,
  todo: 1,
  in_review: 2,
  in_progress: 3,
  backlog: 4,
  done: 5,
  canceled: 6,
};

// 优先级
export const PRI_LABEL: Record<string, string> = {
  urgent: '紧急',
  high: '高',
  medium: '中',
  low: '低',
  none: '',
};

// 任务（load_data 返回形状；与 Rust TaskRow 一致，camelCase 由 Tauri 自动转换）
export interface Task {
  id: string;
  identifier: string;
  projectId?: string;
  title: string;
  status: Status;
  priority: string;
  dueDate: string | null;
  startDate?: string | null;
  description: string | null;
  labels?: string[];
  creatorType: 'user' | 'agent';
  creatorName: string | null;
  threadId: string | null;
  archivedAt?: string | null; // 非空 = 已归档（fullboard OtherTasksPanel 收纳）
  sortOrder: number; // 列内排序（拖拽落点计算；db list_tasks 恒返回）
  createdAt: string;
  version: number;
}

export interface Project {
  id: string;
  name: string;
  labels?: string[]; // 项目标签库（fullboard LabelPicker/筛选）
}

export interface Comment {
  id: string;
  authorType: 'user' | 'agent';
  authorName: string;
  body: string;
  createdAt: string;
}

export interface Activity {
  actorType: string;
  actorName: string;
  changes: string; // JSON: [{field, before, after}]
  createdAt: string;
}

export interface IssueDetail {
  task: Task;
  comments: Comment[];
  activities: Activity[];
  relations?: {
    parent: Array<{ id: string; identifier: string; title: string }>;
    blocks: Array<{ id: string; identifier: string; title: string }>;
    blockedBy: Array<{ id: string; identifier: string; title: string }>;
    related: Array<{ id: string; identifier: string; title: string }>;
  };
  attachments?: Array<{
    id: string;
    filename: string;
    contentType: string;
    size: number;
    createdAt: string;
  }>;
}

export interface CreateTaskInput {
  title: string;
  status?: string;
  priority?: string;
  dueDate?: string | null;
}

// Rust db::CommandError 形态
export interface CommandError {
  code: string;
  message: string;
}

export function isCommandError(e: unknown): e is CommandError {
  return typeof e === 'object' && e !== null && 'code' in e && 'message' in e;
}
