/* ============================================================
 * 通用 toast —— 单例语义（旧 config.js showToast 的等价迁移）
 * 挂件内 3 秒自动消失；error=true 用警示色。重复弹出重置计时。
 * ============================================================ */

export type ToastPayload = { message: string; error: boolean; seq: number };

// 错误 → toast 文案（旧 (e && (e.message || e)) || fallback 的安全版）
export function errMsg(e: unknown, fallback: string): string {
  const m = (e as { message?: unknown } | null | undefined)?.message;
  return (typeof m === 'string' && m) || fallback;
}

let _listener: ((p: ToastPayload) => void) | null = null;
let _seq = 0;

// 任意模块调用展示 toast（Toast 组件负责实际 DOM）
export function showToast(message: string, error?: boolean): void {
  _listener?.({ message, error: !!error, seq: ++_seq });
}

// Toast 组件挂载时绑定；返回解绑函数
export function bindToast(fn: ((p: ToastPayload) => void) | null): () => void {
  _listener = fn;
  return () => {
    if (_listener === fn) _listener = null;
  };
}
