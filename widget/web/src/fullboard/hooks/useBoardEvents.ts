/* ============================================================
 * 全版看板事件 hook —— 多窗口同步
 * 同一 Tauri 进程内 mini 与 fullboard 两窗口共享 emit 广播；
 * 收到任一写事件即全量刷新（单项目量级足够，无需增量 patch）。
 * StrictMode 双挂载竞态处理与 mini 的 useTauriEvents 同模式。
 * ============================================================ */
import { useEffect } from 'react';
import { listen } from '../../lib/tauri';
import { loadBoardData, markOffline } from '../api';

const EVENTS = [
  'task-created',
  'task-moved',
  'task-comment',
  'task-updated',
  'task-archived',
  'task-restored',
  'task-deleted',
  'labels-updated',
  'relation-updated',
] as const;

export function useBoardEvents(): void {
  useEffect(() => {
    const unlistens: Array<() => void> = [];
    let cancelled = false;

    (async () => {
      for (const name of EVENTS) {
        const un = await listen(name, () => {
          loadBoardData().catch(markOffline);
        });
        unlistens.push(un);
      }
      if (cancelled) unlistens.forEach((u) => u());
    })().catch((e) => console.error('board events connect failed', e));

    return () => {
      cancelled = true;
      unlistens.forEach((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载时连接
  }, []);
}

// 轮询兜底（外部进程 taskctl 写库的感知；间隔同 mini 5s）
import { POLL_OK_MS } from '../../lib/types';

export function useBoardPolling(): void {
  useEffect(() => {
    let timer: number | undefined;
    let cancelled = false;
    const tick = async () => {
      try {
        await loadBoardData();
      } catch {
        markOffline();
      }
      if (!cancelled) timer = window.setTimeout(tick, POLL_OK_MS);
    };
    timer = window.setTimeout(tick, POLL_OK_MS);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载时启动链
  }, []);
}
