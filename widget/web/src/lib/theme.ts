/* ============================================================
 * 主题管理（mini / fullboard 共享）
 * ------------------------------------------------------------
 * 解析顺序：localStorage 显式选择 > prefers-color-scheme > 暗色。
 * html class 只落 'dark' | 'light'（驱动 tokens.css 的 SEMANTIC 块
 * 与 theme.css 的 shadcn 变量映射，var 链动态跟随）。
 * 防闪：mini.html / fullboard.html 的 <head> 内联同逻辑的同步脚本
 * （见两文件 THEME-BOOT 段），React 加载前 class 已就位。
 * ============================================================ */

export type ThemeMode = 'light' | 'dark';
const STORAGE_KEY = 'taskboard-theme';

export function resolveTheme(): ThemeMode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* localStorage 不可用（隐私模式等）走系统偏好 */
  }
  if (window.matchMedia?.('(prefers-color-scheme: light)').matches) return 'light';
  return 'dark';
}

export function applyTheme(mode: ThemeMode): void {
  document.documentElement.className = mode;
}

export function currentTheme(): ThemeMode {
  return document.documentElement.classList.contains('light') ? 'light' : 'dark';
}

export function setTheme(mode: ThemeMode): void {
  applyTheme(mode);
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* 持久化失败仅影响下次启动偏好 */
  }
}

export function toggleTheme(): ThemeMode {
  const next: ThemeMode = currentTheme() === 'dark' ? 'light' : 'dark';
  setTheme(next);
  return next;
}

/** React 启动时调用：同步一次（内联脚本已设，幂等）+ 监听系统偏好变化 */
export function initTheme(): void {
  applyTheme(resolveTheme());
  // 无显式选择时跟随系统实时切换；有显式选择则不动
  window.matchMedia?.('(prefers-color-scheme: light)').addEventListener('change', () => {
    try {
      if (localStorage.getItem(STORAGE_KEY)) return;
    } catch {
      /* 无存储则视为跟随系统 */
    }
    applyTheme(resolveTheme());
  });
}
