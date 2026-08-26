/* ============================================================
 * 面板延迟卸载 —— 详情抽屉两段式退出的通用化：
 *   open=false 不立即卸载，先给 closing 态跑退出动画（CSS .closing
 *   keyframes），动画结束才真正 unmount。重开时取消挂起的卸载定时器。
 * 与 App.closeDetail 同语义（定时器可取消，closing 中途重开不闪卸）。
 * ============================================================ */
import { useEffect, useState } from 'react';

export function useExitAnimation(open: boolean, ms = 120): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      setClosing(false);
      return;
    }
    if (!mounted) return;
    setClosing(true);
    const t = window.setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, ms);
    return () => window.clearTimeout(t);
    // mounted 不入依赖：closing 期间 mounted 必为 true，入依赖反会在
    // 卸载前一帧重跑 effect 重置定时器
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return { mounted, closing };
}
