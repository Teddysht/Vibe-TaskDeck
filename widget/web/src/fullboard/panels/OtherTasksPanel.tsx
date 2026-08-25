/* ============================================================
 * 归档任务侧栏 —— 对齐 upstream OtherTasksPanel：
 * 展示 archivedAt 非空的任务，支持恢复（restore_task）与永久删除
 * （delete_task，仅归档可删）。折叠态收纳在右侧边栏。
 * ============================================================ */
import { useState } from 'react';
import { invoke } from '../../lib/tauri';
import { errMsg, showToast } from '../../lib/toast';
import { STATUS_LABEL } from '../../lib/types';
import type { Task } from '../../lib/types';
import { useBoardStore } from '../store/useBoardStore';
import { loadBoardData } from '../api';
import { pushUndo } from '../store/undoStack';

export default function OtherTasksPanel() {
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const tasks = useBoardStore((s) => s.tasks);
  const archived = tasks.filter((t) => t.archivedAt);

  async function restore(task: Task) {
    setBusyId(task.id);
    try {
      await invoke('restore_task', { id: task.id, version: task.version });
      await loadBoardData();
      pushUndo({
        label: `已撤销：恢复归档 ${task.identifier}`,
        undo: () =>
          invoke('archive_task', {
            id: task.id,
            version: useBoardStore.getState().tasks.find((t) => t.id === task.id)?.version ?? 1,
          }).then(() => loadBoardData()),
      });
    } catch (e) {
      showToast(errMsg(e, '恢复失败'), true);
    } finally {
      setBusyId(null);
    }
  }

  async function remove(task: Task) {
    if (!window.confirm(`永久删除「${task.title}」（${task.identifier}）？此操作不可撤销。`)) return;
    setBusyId(task.id);
    try {
      await invoke('delete_task', { id: task.id, version: task.version });
      await loadBoardData();
      showToast(`已删除 ${task.identifier}`);
    } catch (e) {
      showToast(errMsg(e, '删除失败'), true);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className={`fb-other${open ? ' open' : ''}`}>
      <button className="fb-other-toggle" onClick={() => setOpen((v) => !v)}>
        归档 {archived.length}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d={open ? 'M15 18l-6-6 6-6' : 'M9 18l6-6-6-6'} />
        </svg>
      </button>
      {open && (
        <div className="fb-other-list">
          {archived.map((t) => (
            <div key={t.id} className="fb-other-item" data-task-id={t.id}>
              <span className="id">{t.identifier}</span>
              <span className="title" title={t.title}>{t.title}</span>
              <span className="status">{STATUS_LABEL[t.status] || t.status}</span>
              <button
                disabled={busyId === t.id}
                title="恢复到看板"
                onClick={() => restore(t)}
              >恢复</button>
              <button
                className="danger"
                disabled={busyId === t.id}
                title="永久删除（不可撤销）"
                onClick={() => remove(t)}
              >删除</button>
            </div>
          ))}
          {archived.length === 0 && <div className="fb-other-empty">没有归档任务</div>}
        </div>
      )}
    </div>
  );
}
