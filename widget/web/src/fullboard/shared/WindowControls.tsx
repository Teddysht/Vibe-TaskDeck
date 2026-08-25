/* ============================================================
 * 窗口控制（无框标题栏右端）：最小化 / 最大化切换 / 关闭。
 * 语言对齐挂件 .hd .ic（圆角图标按钮、close hover 危险色），
 * 尺寸放大到桌面窗口点击目标（36×32）。退化为浏览器直开时隐藏。
 * ============================================================ */
import { useEffect, useState } from 'react';
import { getCurrentWindow, type Window } from '@tauri-apps/api/window';
import { hasTauri } from '../../lib/tauri';

// getCurrentWindow() 依赖 __TAURI_INTERNALS__.metadata.currentWindow.label——
// e2e mock 层只注入 invoke 不注入 metadata，直接调用会 TypeError 崩树。
function tryGetCurrentWindow(): Window | null {
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

export default function WindowControls() {
  const win = tryGetCurrentWindow();
  // 浏览器直开 / e2e mock 层（无窗口元数据）时整组隐藏
  if (!win) return null;
  return <WindowControlsInner win={win} />;
}

function WindowControlsInner({ win }: { win: Window }) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    // 最大化态跟踪：双击标题栏/还原都会触发系统 resize 事件
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

  return (
    <div className="fb-winctl">
      <button
        className="wc-btn"
        title="最小化"
        aria-label="最小化"
        onClick={() => win.minimize().catch(() => {})}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M5 12h14" />
        </svg>
      </button>
      <button
        className="wc-btn"
        title={maximized ? '还原' : '最大化'}
        aria-label={maximized ? '还原' : '最大化'}
        onClick={() => win.toggleMaximize().catch(() => {})}
      >
        {maximized ? (
          /* 还原：双叠方块 */
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="8" y="8" width="12" height="12" rx="2" />
            <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
            <rect x="5" y="5" width="14" height="14" rx="2" />
          </svg>
        )}
      </button>
      <button
        className="wc-btn wc-close"
        title="关闭"
        aria-label="关闭"
        onClick={() => win.close().catch(() => {})}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  );
}
