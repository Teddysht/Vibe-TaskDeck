/* ============================================================
 * Toast —— #toast 单例（e2e 契约：id、.show、.error 类、3s 消失）
 * ============================================================ */
import { useEffect, useState } from 'react';
import { bindToast } from '../lib/toast';

export default function Toast() {
  const [toast, setToast] = useState<{ message: string; error: boolean; seq: number } | null>(null);

  useEffect(() => {
    const unbind = bindToast(setToast);
    return unbind;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 单例绑定
  }, []);

  // 3 秒自动消失；重复弹出（seq 变化）重置计时
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <div
      id="toast"
      className={toast ? `show${toast.error ? ' error' : ''}` : undefined}
    >
      {toast?.message ?? ''}
    </div>
  );
}
