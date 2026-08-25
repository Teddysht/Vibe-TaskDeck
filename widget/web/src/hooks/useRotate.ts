/* ============================================================
 * mini 轮转 hook —— 仅 mini 视图激活（替代旧 startRotate/stopRotate 手动配对）
 * ============================================================ */
import { useEffect } from 'react';
import { useAppStore } from '../store/useAppStore';
import { ROTATE_MS } from '../lib/types';

export function useRotate(): void {
  const view = useAppStore((s) => s.view);
  useEffect(() => {
    if (view !== 'mini') return;
    const t = window.setInterval(() => useAppStore.getState().rotate(), ROTATE_MS);
    return () => clearInterval(t);
  }, [view]);
}
