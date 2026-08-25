/* ============================================================
 * 中央状态 —— zustand（镜像旧 state.js 的形状与语义）
 *
 * 数据流：api 层写入 store → React 订阅组件按 selector 局部重渲染
 * （替代旧 pub/sub 的 notify-all 全量重绘）。
 *
 * view 初始化说明（旧 bridge.js 黑屏陷阱的来龙去脉）：
 * 旧版 state.view 初始为 null，防止「首启 switchView('mini') 被同值守卫
 * 早退、容器停在 display:none 导致整窗黑屏」。React 由状态驱动渲染，
 * 该陷阱结构性消失——初始直接为 'mini'，首启不调 set_window_size
 * （main.rs 已按 280×48 建窗）。勿回退成 null。
 *
 * 布局说明（快捷看板移除后）：
 * large 内只有 list 单一布局 + detail 覆盖态（不改窗口尺寸）；
 * 需要多列看板时走「全版看板」第二窗口（openFullBoard）。
 * ============================================================ */
import { create } from 'zustand';
import { ROT_ORDER } from '../lib/types';
import type { IssueDetail, Project, Task } from '../lib/types';

export type View = 'mini' | 'large';
// large 内部状态：list 布局 或 detail 覆盖态（不改窗口尺寸）
export type LargeState = 'list' | 'detail';

interface AppState {
  tasks: Task[];
  projects: Project[];
  online: boolean;
  seq: Task[]; // 轮转序列（已排序、剔除完成/取消）
  idx: number; // 轮转当前位置
  view: View;
  filter: string; // large 列表筛选：'all' | 状态枚举
  largeView: LargeState;
  detailId: string | null;
  detail: IssueDetail | null;

  // 写入数据并重算派生序列
  setData(tasks: Task[], projects: Project[], online: boolean): void;
  setOnline(online: boolean): void;
  setFilter(f: string): void;
  setIdx(i: number): void;
  rotate(): void;
  setView(v: View): void;
  openDetail(id: string): void; // 置 detail 覆盖态
  closeDetail(): void; // 回 list
  setDetail(d: IssueDetail | null): void;
  // 收起时静默重置 detail 态（旧 bridge.js:78-83 等价）
  closeDetailIfOpen(): void;
}

export const useAppStore = create<AppState>((set, get) => ({
  tasks: [],
  projects: [],
  online: true,
  seq: [],
  idx: 0,
  view: 'mini',
  filter: 'all',
  largeView: 'list',
  detailId: null,
  detail: null,

  setData: (tasks, projects, online) =>
    set(() => {
      const seq = tasks
        .filter((t) => t.status !== 'done' && t.status !== 'canceled')
        .sort(
          (a, b) =>
            (ROT_ORDER[a.status] - ROT_ORDER[b.status]) ||
            (a.dueDate ? 0 : 1) - (b.dueDate ? 0 : 1),
        );
      const idx = get().idx >= seq.length ? 0 : get().idx;
      return { tasks, projects, online, seq, idx };
    }),

  setOnline: (online) => set({ online }),

  setFilter: (filter) => set({ filter }),

  setIdx: (idx) => set({ idx }),

  rotate: () => {
    const { seq, idx } = get();
    if (!seq.length) return;
    set({ idx: (idx + 1) % seq.length });
  },

  setView: (view) => set({ view }),

  openDetail: (id) =>
    set({ detailId: id, largeView: 'detail' }),

  closeDetail: () => set({ largeView: 'list', detailId: null, detail: null }),

  setDetail: (detail) => set({ detail }),

  closeDetailIfOpen: () => {
    if (get().largeView !== 'detail') return;
    set({ largeView: 'list', detailId: null, detail: null });
  },
}));
