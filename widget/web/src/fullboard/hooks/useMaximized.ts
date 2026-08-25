/* ============================================================
 * 最大化态跟踪 hook（WindowControls 与 App 根圆角共享）。
 * 双击标题栏/按钮切换/还原都会触发 resize——onResized 后重查
 * isMaximized 为准。mock/浏览器环境（无窗口元数据）恒 false。
 * ============================================================ */
import { useEffect, useState } from 'react';
import { getCurrentWindow, type Window } from '@tauri-apps/api/window';
import { hasTauri } from '../../lib/tauri';

// getCurrentWindow() 依赖 __TAURI_INTERNALS__.metadata——mock 层只注入
// invoke 不注入 metadata，直接调用会 TypeError。探测降级返回 null。
export function tryGetCurrentWindow(): Window | null {
  if (!hasTauri()) return null;
  try {
    const meta = (window as unknown as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } } })
      .__TAURI_INTERNALS__?.metadata;
    if (!meta?.currentWindow?.label) return null;
    return getCurrentWindow();
  } catch {
    return null;
  }
}

export function useMaximized(win: Window | null): boolean {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!win) return;
    let unlisten: (() => void) | undefined;
    win.isMaximized().then(setMaximized).catch(() => {});
    win
      .onResized(async () => {
        setMaximized(await win.isMaximized().catch(() => false));
      })
      .then((fn) => {
        if (typeof fn === 'function') unlisten = fn;
      })
      .catch(() => {});
    return () => {
      // mock 层 listen 可能 resolve 非函数（如 unlisten id），仅函数时调用
      if (typeof unlisten === 'function') unlisten();
    };
  }, [win]);
  return maximized;
}
