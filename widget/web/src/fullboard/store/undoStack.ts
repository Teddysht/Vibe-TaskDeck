/* ============================================================
 * undo 栈 —— 对齐 upstream App.tsx:1919-1946 语义：
 * 上限 20、in-flight 防重入、撤销失败弹错（不静默）。
 * ============================================================ */
import { showToast } from '../../lib/toast';

export interface UndoEntry {
  label: string; // undo toast 文案（如「已撤销流转」）
  undo: () => Promise<void>;
}

const MAX_UNDO = 20;
let stack: UndoEntry[] = [];
let inFlight = false;
let listener: ((count: number) => void) | null = null;

export function pushUndo(entry: UndoEntry): void {
  stack.push(entry);
  if (stack.length > MAX_UNDO) stack = stack.slice(-MAX_UNDO);
  listener?.(stack.length);
}

export function undoCount(): number {
  return stack.length;
}

// 撤销最近一次操作；成功返回 true（无操作/失败返回 false）
export async function undoLast(): Promise<boolean> {
  if (inFlight || stack.length === 0) return false;
  inFlight = true;
  const entry = stack.pop()!;
  listener?.(stack.length);
  try {
    await entry.undo();
    showToast(entry.label);
    return true;
  } catch (e) {
    console.error('undo failed', e);
    showToast('撤销失败：任务可能已被外部修改', true);
    return false;
  } finally {
    inFlight = false;
  }
}

export function bindUndoCount(fn: ((count: number) => void) | null): void {
  listener = fn;
}
