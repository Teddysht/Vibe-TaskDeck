/* ============================================================
 * 新建任务 Popover —— 标题栏「新建 N」按钮触发的下拉表单。
 * 复用挂件 NewTaskPanel 同一 create_task 命令；Enter 提交，
 * 成功后关面板 + loadBoardData 刷新看板。
 * ============================================================ */
import { useEffect, useRef, useState } from 'react';
import { invoke } from '../../lib/tauri';
import { PRI_LABEL, STATUS_LABEL } from '../../lib/types';
import { loadBoardData } from '../api';

export default function NewTaskPopover({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const titleRef = useRef<HTMLInputElement>(null);
  const statusRef = useRef<HTMLSelectElement>(null);
  const priRef = useRef<HTMLSelectElement>(null);
  const dueRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // 打开时清空表单并聚焦标题
  useEffect(() => {
    if (!open) return;
    setError('');
    if (titleRef.current) {
      titleRef.current.value = '';
      titleRef.current.focus();
    }
    if (statusRef.current) statusRef.current.value = 'todo';
    if (priRef.current) priRef.current.value = 'none';
    if (dueRef.current) dueRef.current.value = '';
  }, [open]);

  async function submit() {
    const title = titleRef.current?.value.trim();
    if (!title) {
      setError('标题必填');
      titleRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      await invoke('create_task', {
        title,
        status: statusRef.current?.value ?? 'todo',
        priority: priRef.current?.value ?? 'none',
        dueDate: dueRef.current?.value || null,
      });
      onClose();
      await loadBoardData();
    } catch (e) {
      setError(String((e as Error)?.message || e).replace(/^\d+\s*/, '') || '创建失败');
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fb-newtask" data-testid="newtask-popover">
      <input
        ref={titleRef}
        className="fb-newtask-title"
        placeholder="任务标题…（Enter 创建）"
        maxLength={240}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="fb-newtask-row">
        <select ref={statusRef} defaultValue="todo" aria-label="状态">
          {Object.entries(STATUS_LABEL).map(([s, l]) => (
            <option key={s} value={s}>{l}</option>
          ))}
        </select>
        <select ref={priRef} defaultValue="none" aria-label="优先级">
          {Object.entries(PRI_LABEL).map(([p, l]) => (
            <option key={p} value={p}>{l || '无'}</option>
          ))}
        </select>
        <input ref={dueRef} type="date" aria-label="截止日期" />
      </div>
      {error && <div className="fb-newtask-err">{error}</div>}
      <div className="fb-newtask-foot">
        <span className="hint">Enter 创建 · Esc 关闭</span>
        <button className="fb-newtask-submit" disabled={busy} onClick={submit}>
          {busy ? '创建中…' : '创建任务'}
        </button>
      </div>
    </div>
  );
}
