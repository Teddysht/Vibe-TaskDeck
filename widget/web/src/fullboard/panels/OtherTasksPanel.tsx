/* ============================================================
 * 归档任务弹窗 —— 顶栏入口 + 右侧 Sheet（对齐详情面板同一语言）：
 * 展示 archivedAt 非空的任务，支持恢复（restore_task）与永久删除
 * （delete_task，仅归档可删）。
 * ============================================================ */
import { useEffect, useState } from 'react';
import { invoke } from '../../lib/tauri';
import { errMsg, showToast } from '../../lib/toast';
import { STATUS_LABEL } from '../../lib/types';
import type { Task } from '../../lib/types';
import { useBoardStore } from '../store/useBoardStore';
import { loadBoardData } from '../api';
import { pushUndo } from '../store/undoStack';
import { useExitAnimation } from '../hooks/useExitAnimation';

export default function OtherTasksPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const tasks = useBoardStore((s) => s.tasks);
  const archived = tasks.filter((t) => t.archivedAt);
  // 退出与详情抽屉同语言：closing 120ms fb-panel-out 后卸载
  const { mounted, closing } = useExitAnimation(open);

  // Esc 关闭（与详情面板同款契约）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

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

  if (!mounted) return null;

  return (
    <aside className={`fb-archive${closing ? ' closing' : ''}`} aria-label="归档任务">
      <header className="d-hd">
        <span className="d-id">归档 {archived.length > 0 ? `· ${archived.length}` : ''}</span>
        <span className="sp" />
        <button className="d-close" title="关闭（Esc）" aria-label="关闭归档" onClick={onClose}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </header>
      <div className="fb-archive-body">
        {archived.map((t) => (
          <div key={t.id} className="fb-archive-item" data-task-id={t.id}>
            <span className="id">{t.identifier}</span>
            <span className="title" title={t.title}>{t.title}</span>
            <span className="status">
              <span className={`col-dot st-${t.status}`} aria-hidden="true" />
              {STATUS_LABEL[t.status] || t.status}
            </span>
            <button
              className="act restore"
              disabled={busyId === t.id}
              title="恢复到看板"
              onClick={() => restore(t)}
            >恢复</button>
            <button
              className="act danger"
              disabled={busyId === t.id}
              title="永久删除（不可撤销）"
              onClick={() => remove(t)}
            >删除</button>
          </div>
        ))}
        {archived.length === 0 && <div className="fb-archive-empty">没有归档任务</div>}
      </div>
    </aside>
  );
}
