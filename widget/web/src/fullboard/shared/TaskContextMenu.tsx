/* ============================================================
 * 卡片右键菜单 —— 自绘（对齐 upstream TaskContextMenu 核心项）：
 * 完成（in_review→done）/ 归档 / 打开详情。菜单项按状态条件显示。
 * ============================================================ */
import { useEffect, useRef } from 'react';
import { invoke } from '../../lib/tauri';
import { errMsg, showToast } from '../../lib/toast';
import type { Task } from '../../lib/types';
import { loadBoardData } from '../api';
import { pushUndo } from '../store/undoStack';
import { useBoardStore } from '../store/useBoardStore';

export interface MenuState {
  task: Task;
  x: number;
  y: number;
}

export default function TaskContextMenu({
  state,
  onClose,
  onOpenDetail,
}: {
  state: MenuState;
  onClose: () => void;
  onOpenDetail: (task: Task) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { task, x, y } = state;

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  async function complete() {
    onClose();
    try {
      await invoke('update_task', { id: task.id, version: task.version, changes: { status: 'done' } });
      await loadBoardData();
    } catch (e) {
      showToast(errMsg(e, '操作失败'), true);
    }
  }

  async function archive() {
    onClose();
    try {
      await invoke('archive_task', { id: task.id, version: task.version });
      await loadBoardData();
      pushUndo({
        label: `已撤销：归档 ${task.identifier}`,
        undo: () =>
          invoke('restore_task', {
            id: task.id,
            version: useBoardStore.getState().tasks.find((t) => t.id === task.id)?.version ?? 1,
          }).then(() => loadBoardData()),
      });
    } catch (e) {
      showToast(errMsg(e, '归档失败'), true);
    }
  }

  return (
    <div className="fb-ctxmenu" ref={ref} style={{ left: x, top: y }} onContextMenu={(e) => e.preventDefault()}>
      <button onClick={() => { onClose(); onOpenDetail(task); }}>打开详情</button>
      {task.status !== 'done' && task.status !== 'canceled' && (
        <button onClick={complete}>标记完成</button>
      )}
      <button onClick={archive}>归档</button>
    </div>
  );
}
