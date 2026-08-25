/* ============================================================
 * 全版看板数据层 —— command 封装（随各期扩展）
 * 语义与 mini 的 lib/api.ts 对齐（同批 command），但独立维护：
 * fullboard 有自己的重试/undo 需求，不与 mini 相互牵连。
 * ============================================================ */
import { invoke } from '../lib/tauri';
import { useBoardStore } from './store/useBoardStore';
import type { Project, Task } from '../lib/types';

// 拉取全量（含归档；projects 带 labels）
export async function loadBoardData(): Promise<void> {
  const data = await invoke<{ tasks?: Task[]; projects?: Project[] }>('load_data');
  useBoardStore.getState().setData(data.tasks ?? [], data.projects ?? [], true);
}

// 刷新失败时置离线（轮询/事件兜底用）
export function markOffline(): void {
  useBoardStore.getState().setOnline(false);
}
