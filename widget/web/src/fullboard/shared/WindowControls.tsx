/* ============================================================
 * 窗口控制（无框标题栏右端）：最小化 / 最大化切换 / 关闭。
 * 语言对齐挂件 .hd .ic（圆角图标按钮、close hover 危险色），
 * 尺寸放大到桌面窗口点击目标（36×32）。退化为浏览器直开时隐藏。
 * 最大化态改由共享 useMaximized hook 提供（App 根圆角同源）。
 * ============================================================ */
import { useMaximized, tryGetCurrentWindow } from '../hooks/useMaximized';

export default function WindowControls() {
  const win = tryGetCurrentWindow();
  // 浏览器直开 / e2e mock 层（无窗口元数据）时整组隐藏
  if (!win) return null;
  return <WindowControlsInner win={win} />;
}

function WindowControlsInner({ win }: { win: import('@tauri-apps/api/window').Window }) {
  const maximized = useMaximized(win);

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
