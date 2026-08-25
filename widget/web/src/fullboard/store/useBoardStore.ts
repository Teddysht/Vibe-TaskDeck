/* ============================================================
 * 全版看板中央状态 —— zustand
 * 数据流：api 层写入 store → 组件按 selector 局部重渲染；
 * 刷新来源 = 写操作后的本地 setData + Rust emit 事件（多窗口同步）。
 * ============================================================ */
import { create } from 'zustand';
import { ROT_ORDER } from '../../lib/types';
import type { Project, Task } from '../../lib/types';
import { EMPTY_TASK_FILTERS, type TaskFilters } from '../taskFilters';

export type ViewMode = 'board' | 'list';

interface BoardState {
  tasks: Task[]; // 含归档（archivedAt 非空即归档态）
  projects: Project[];
  online: boolean;
  viewMode: ViewMode;
  selectedId: string | null; // 详情抽屉当前任务（?issue= 路由驱动）
  filters: TaskFilters;

  setData(tasks: Task[], projects: Project[], online: boolean): void;
  setOnline(online: boolean): void;
  setViewMode(v: ViewMode): void;
  select(id: string | null): void;
  setFilters(f: TaskFilters): void;
}

export const useBoardStore = create<BoardState>((set) => ({
  tasks: [],
  projects: [],
  online: true,
  viewMode: 'board',
  selectedId: null,
  filters: { ...EMPTY_TASK_FILTERS },

  setData: (tasks, projects, online) => set({ tasks, projects, online }),
  setOnline: (online) => set({ online }),
  setViewMode: (viewMode) => set({ viewMode }),
  select: (selectedId) => set({ selectedId }),
  setFilters: (filters) => set({ filters }),
}));

// 看板主视图 7 列状态序（对齐 upstream issueBoardStatuses；
// 与 mini 的 STATUS_ORDER 差异：此处 canceled 也入列，靠归档收纳）
export const BOARD_COLUMNS = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'blocked',
  'done',
  'canceled',
] as const;

export const COLUMN_LABEL: Record<string, string> = {
  backlog: '待办池',
  todo: '待处理',
  in_progress: '进行中',
  in_review: '待评审',
  blocked: '阻塞',
  done: '已完成',
  canceled: '已取消',
};

// 非归档任务按状态分列（board 主视图数据源）
export function columnsOf(tasks: Task[]): Record<string, Task[]> {
  const by: Record<string, Task[]> = {};
  BOARD_COLUMNS.forEach((s) => {
    by[s] = [];
  });
  tasks.forEach((t) => {
    if (t.archivedAt) return; // 归档不进主视图（OtherTasksPanel 收纳）
    (by[t.status] || by.backlog).push(t);
  });
  return by;
}

void ROT_ORDER; // 排序语义后续与 sortOrder 对齐（P2 拖拽期引入）
