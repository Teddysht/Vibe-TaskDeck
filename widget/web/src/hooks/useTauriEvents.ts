/* ============================================================
 * Tauri 事件 hook —— task-created / task-moved / task-updated / task-comment
 * ⚠ 事件名不得含点号：Tauri v2 事件名校验只允许字母数字与 - / : _，
 *   旧名 task.created 曾被静默拒绝（错误被吞），一直靠轮询兜底。
 * StrictMode 双挂载：unlisten 是异步 promise，cleanup 需处理
 * 「卸载先于 listen resolve」的竞态（cancelled flag + 事后反注册）
 * ============================================================ */
import { useEffect } from 'react';
import { loadData, refreshDetail } from '../lib/api';
import { listen } from '../lib/tauri';
import { useAppStore } from '../store/useAppStore';

export function useTauriEvents(): void {
  useEffect(() => {
    const unlistens: Array<() => void> = [];
    let cancelled = false;

    (async () => {
      for (const name of ['task-created', 'task-moved'] as const) {
        const un = await listen(name, () => {
          loadData().catch(() => useAppStore.getState().setOnline(false));
        });
        unlistens.push(un);
      }
      // 全版看板/外部字段编辑（update_task）→ 列表即时刷新 + 详情顺带刷新
      // （未补此前 L2 详情要等 5s 轮询才看到全版看板改的标题/优先级）
      const unUpd = await listen('task-updated', () => {
        loadData().catch(() => useAppStore.getState().setOnline(false));
        refreshDetail().catch(() => {});
      });
      unlistens.push(unUpd);
      const un = await listen('task-comment', () => {
        refreshDetail().catch(() => {});
      });
      unlistens.push(un);
      // await 期间组件已卸载（StrictMode 双挂载的第一轮）→ 立即反注册
      if (cancelled) unlistens.forEach((u) => u());
    })().catch((e) => console.error('connect events failed', e));

    return () => {
      cancelled = true;
      unlistens.forEach((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载时连接
  }, []);
}
