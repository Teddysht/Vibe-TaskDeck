/* ============================================================
 * 开机自启开关（mini 大面板 / fullboard 标题栏共享）
 * 经 autostart 插件读写启动项；mock/浏览器环境（无 Tauri 插件桥）
 * 静默降级为不可用。图标：闪电+箭头环。
 * ============================================================ */
import { useEffect, useState } from 'react';
import { hasTauri } from '../lib/tauri';
import { enable as enableAutostart, disable as disableAutostart, isEnabled } from '@tauri-apps/plugin-autostart';

export default function AutostartToggle({ className = '' }: { className?: string }) {
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // 探测当前自启状态；插件不可用（mock/独立浏览器）时保持隐藏
    if (!hasTauri()) return;
    isEnabled()
      .then((v) => { setEnabled(Boolean(v)); setReady(true); })
      .catch(() => setReady(false));
  }, []);

  if (!ready) return null; // 环境不支持时不渲染（mock e2e 不受影响）

  return (
    <button
      className={`${className} autostart${enabled ? ' on' : ''}`}
      title={enabled ? '已开机自启（点击关闭）' : '开机自启（点击开启）'}
      aria-label={enabled ? '关闭开机自启' : '开启开机自启'}
      aria-pressed={enabled}
      onClick={() => {
        const next = !enabled;
        (next ? enableAutostart() : disableAutostart())
          .then(() => setEnabled(next))
          .catch(() => { /* 切换失败保持原态 */ });
      }}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M23 4v6h-6" />
        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
      </svg>
    </button>
  );
}
