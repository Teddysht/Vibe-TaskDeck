/* ============================================================
 * 筛选与搜索 —— 上游 taskFilters.ts 直移（去 link/conversationRefs——
 * 依赖 Codex 会话协议，纯客户端无此数据；labels 显示名简化为原名）
 * URL 同步：?status=&priority=&label=&content=（replaceState，刷新可还原）
 * ============================================================ */
import type { Task } from '../lib/types';

export type TaskFilterKey = 'statuses' | 'priorities' | 'labels' | 'content';

export interface TaskFilters {
  statuses: string[];
  priorities: string[];
  labels: string[];
  content: string;
}

export const EMPTY_TASK_FILTERS: TaskFilters = {
  statuses: [],
  priorities: [],
  labels: [],
  content: '',
};

const STATUS_SET = new Set([
  'backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled',
]);
const PRIORITY_SET = new Set(['none', 'urgent', 'high', 'medium', 'low']);

export function readTaskFilters(): TaskFilters {
  const params = new URLSearchParams(window.location.search);
  return {
    statuses: (params.get('status') ?? '').split(',').filter((s) => STATUS_SET.has(s)),
    priorities: (params.get('priority') ?? '').split(',').filter((p) => PRIORITY_SET.has(p)),
    labels: params.getAll('label').filter(Boolean),
    content: params.get('content') ?? '',
  };
}

export function writeTaskFilters(filters: TaskFilters): void {
  const url = new URL(window.location.href);
  if (filters.statuses.length) url.searchParams.set('status', filters.statuses.join(','));
  else url.searchParams.delete('status');
  if (filters.priorities.length) url.searchParams.set('priority', filters.priorities.join(','));
  else url.searchParams.delete('priority');
  url.searchParams.delete('label');
  filters.labels.forEach((label) => url.searchParams.append('label', label));
  if (filters.content.trim()) url.searchParams.set('content', filters.content.trim());
  else url.searchParams.delete('content');
  window.history.replaceState(null, '', url);
}

export function taskFilterCount(filters: TaskFilters): number {
  return (
    Number(filters.statuses.length > 0) +
    Number(filters.priorities.length > 0) +
    Number(filters.labels.length > 0) +
    Number(Boolean(filters.content.trim()))
  );
}

export function matchesTaskSearch(task: Task, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return [task.identifier, task.title, task.description ?? '', ...(task.labels ?? [])]
    .join(' ')
    .toLowerCase()
    .includes(needle);
}

export function matchesTaskFilters(task: Task, filters: TaskFilters, omit?: TaskFilterKey): boolean {
  if (omit !== 'statuses' && filters.statuses.length && !filters.statuses.includes(task.status)) {
    return false;
  }
  if (omit !== 'priorities' && filters.priorities.length && !filters.priorities.includes(task.priority)) {
    return false;
  }
  if (
    omit !== 'labels' &&
    filters.labels.length &&
    !filters.labels.some((label) => (task.labels ?? []).includes(label))
  ) {
    return false;
  }
  if (omit !== 'content') {
    const content = filters.content.trim().toLowerCase();
    if (content && ![task.title, task.description ?? ''].join(' ').toLowerCase().includes(content)) {
      return false;
    }
  }
  return true;
}
