/* ============================================================
 * 轮询 hook —— setTimeout 链语义（间隔每拍现取，链不被 store 变化重置）
 * 在线 5s 兜底 / 离线 5s 重试；详情开着时顺带刷新（外部可能改了状态或评论）
 * ============================================================ */
import { useEffect } from 'react';
import { loadData, refreshDetail } from '../lib/api';
import { useAppStore } from '../store/useAppStore';
import { POLL_OK_MS, RETRY_MS } from '../lib/types';

export function usePolling(): void {
  useEffect(() => {
    let timer: number | undefined;
    let cancelled = false;

    const tick = async () => {
      try {
        await loadData();
        // 详情开着时顺带刷新
        if (useAppStore.getState().largeView === 'detail') {
          await refreshDetail();
        }
      } catch {
        useAppStore.getState().setOnline(false);
      }
      if (!cancelled) {
        const delay = useAppStore.getState().online ? POLL_OK_MS : RETRY_MS;
        timer = window.setTimeout(tick, delay);
      }
    };

    timer = window.setTimeout(tick, POLL_OK_MS);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载时启动链
  }, []);
}
