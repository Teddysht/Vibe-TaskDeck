/* ============================================================
 * 主题切换按钮（mini 大面板 / fullboard 标题栏共享）
 * 图标随当前主题切换（dark 显示太阳=切到亮色，light 显示月亮）。
 * class 由调用方给（.ic 挂件语言 / wc 风格 fullboard 语言）。
 * ============================================================ */
import { useEffect, useState } from 'react';
import { currentTheme, toggleTheme, type ThemeMode } from '../lib/theme';
import { listen } from '../lib/tauri';

export default function ThemeToggle({ className = '' }: { className?: string }) {
  const [mode, setMode] = useState<ThemeMode>(currentTheme());
  // 另一窗切换主题时同步本按钮图标（theme-changed 全窗广播）
  useEffect(() => {
    const p = listen<string>('theme-changed', (e) => {
      if (e.payload === 'light' || e.payload === 'dark') setMode(e.payload);
    });
    return () => {
      p.then((un) => un()).catch(() => {});
    };
  }, []);
  return (
    <button
      className={className}
      title={mode === 'dark' ? '切换到亮色' : '切换到暗色'}
      aria-label={mode === 'dark' ? '切换到亮色主题' : '切换到暗色主题'}
      onClick={() => setMode(toggleTheme())}
    >
      {mode === 'dark' ? (
        /* 太阳：当前暗色，点击切亮 */
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </svg>
      ) : (
        /* 月亮：当前亮色，点击切暗 */
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  );
}
