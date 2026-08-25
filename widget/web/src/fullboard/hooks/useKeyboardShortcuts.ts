/* ============================================================
 * 键盘快捷键 —— 对齐 upstream App.tsx:1964-2007：
 *   Ctrl/Cmd+Z 撤销最近一次流转/编辑；"/" 聚焦搜索；Esc 关详情
 *   （输入框聚焦时不触发 / 与 Z；Esc 由详情面板自处理）
 * ============================================================ */
import { useEffect } from 'react';
import { undoLast } from '../store/undoStack';

export function useKeyboardShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      // 撤销（输入框内也允许——上游全局生效）
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undoLast();
        return;
      }
      if (typing) return;
      // "/" 聚焦搜索
      if (e.key === '/') {
        e.preventDefault();
        document.getElementById('fb-search')?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}
