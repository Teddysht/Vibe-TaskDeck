/* ============================================================
 * Tauri 桥 —— @tauri-apps/api 封装（替代旧 window.__TAURI__ 直访）
 *
 * 设计不变：不依赖任何 Tauri 插件，全部走自定义 Rust command（invoke），
 * 规避插件权限名与全局 API 模块路径的不确定性。
 * 浏览器直开（无 WebView 客户端注入）时走退化逻辑：invoke 拒绝、listen 空操作。
 * ============================================================ */
import { invoke as tInvoke } from '@tauri-apps/api/core';
import { listen as tListen, type UnlistenFn } from '@tauri-apps/api/event';

// Tauri 客户端注入标记（@tauri-apps/api 存在时页面里必有此内部对象）
export function hasTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// 调用 Rust command；无 Tauri 环境时返回已拒绝的 Promise
export function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!hasTauri()) return Promise.reject(new Error('no tauri'));
  return tInvoke<T>(cmd, args);
}

export type TauriEvent<T = unknown> = { payload: T };

// 监听 Tauri 事件；无环境时返回空清理函数
export async function listen<T = unknown>(
  event: string,
  handler: (e: TauriEvent<T>) => void,
): Promise<UnlistenFn> {
  if (!hasTauri()) return () => {};
  return tListen<T>(event, handler);
}
