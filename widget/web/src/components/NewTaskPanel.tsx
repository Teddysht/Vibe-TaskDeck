/* ============================================================
 * 新建任务面板 —— 折叠交互态（不进 store）
 * ⚠ 硬契约：全部表单非受控（defaultValue + ref 读值）——
 *   e2e 直接设 input.value 不派发事件（e2e-real-verify.mjs:109），
 *   受控输入会拿到空状态，测试即挂。
 * ============================================================ */
import { useEffect, useRef } from 'react';
import { createTask, loadData } from '../lib/api';
import { PRI_LABEL, STATUS_LABEL, STATUS_ORDER } from '../lib/types';

const PRI_OPTIONS = ['none', 'urgent', 'high', 'medium', 'low'];

export default function NewTaskPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const titleRef = useRef<HTMLInputElement>(null);
  const statusRef = useRef<HTMLSelectElement>(null);
  const priRef = useRef<HTMLSelectElement>(null);
  const dueRef = useRef<HTMLInputElement>(null);
  const errRef = useRef<HTMLSpanElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // 关闭时清空表单（等价旧 resetNewPanel；面板常驻 DOM 只切 display）
  useEffect(() => {
    if (open) {
      titleRef.current?.focus();
    } else {
      if (titleRef.current) titleRef.current.value = '';
      if (dueRef.current) dueRef.current.value = '';
      if (statusRef.current) statusRef.current.value = 'backlog';
      if (priRef.current) priRef.current.value = 'none';
      if (errRef.current) errRef.current.textContent = '';
    }
  }, [open]);

  async function submit() {
    const title = titleRef.current?.value.trim() ?? '';
    if (!title) {
      if (errRef.current) errRef.current.textContent = '标题必填';
      return;
    }
    const btn = submitRef.current;
    if (btn) btn.disabled = true;
    try {
      await createTask({
        title,
        status: statusRef.current?.value,
        priority: priRef.current?.value,
        dueDate: dueRef.current?.value || null,
      });
      onClose(); // 关闭并清空
      await loadData().catch(() => {}); // 双保险（Rust 事件也会触发一次）
    } catch (e) {
      if (errRef.current) errRef.current.textContent = (e as Error)?.message || '创建失败';
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  return (
    <div className="newpanel" id="newPanel" ref={panelRef} style={{ display: open ? 'flex' : 'none' }}>
      <input
        id="npTitle"
        ref={titleRef}
        maxLength={240}
        placeholder="任务标题（必填）"
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
          if (e.key === 'Escape') onClose();
        }}
      />
      <div className="nprow">
        <select id="npStatus" ref={statusRef} defaultValue="backlog">
          {STATUS_ORDER.map((s) => (
            <option key={s} value={s}>{STATUS_LABEL[s]}</option>
          ))}
        </select>
        <select id="npPriority" ref={priRef} defaultValue="none">
          {PRI_OPTIONS.map((p) => (
            <option key={p} value={p}>{PRI_LABEL[p] || '无'}</option>
          ))}
        </select>
        <input type="date" id="npDue" ref={dueRef} title="截止日期" />
      </div>
      <div className="nprow">
        <button className="primary" id="npSubmit" ref={submitRef} onClick={submit}>创建</button>
        <button id="npCancel" onClick={onClose}>取消</button>
        <span className="nperr" id="npErr" ref={errRef} />
      </div>
    </div>
  );
}
