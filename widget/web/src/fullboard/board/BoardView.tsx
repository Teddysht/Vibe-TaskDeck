/* ============================================================
 * 看板主视图 —— 7 列 + 拖拽状态机
 * 落点排序：beforeTaskId 有 → 前后卡 sortOrder 中值；
 *           无（列尾/空列）→ 目标列 max + 1000
 * 置后动画：movingTaskId（drop 即置）→ 数据刷新落地后转 settling 200ms
 * ============================================================ */
import { useEffect, useRef, useState } from 'react';
import { invoke } from '../../lib/tauri';
import { errMsg, showToast } from '../../lib/toast';
import { isCommandError } from '../../lib/types';
import type { Task } from '../../lib/types';
import BoardColumn from './BoardColumn';
import { BOARD_COLUMNS, columnsOf, useBoardStore } from '../store/useBoardStore';
import { loadBoardData } from '../api';
import { matchesTaskFilters } from '../taskFilters';
import { pushUndo } from '../store/undoStack';

export default function BoardView({
  onCardClick,
  onContextMenu,
}: {
  onCardClick: (task: Task) => void;
  onContextMenu: (task: Task, x: number, y: number) => void;
}) {
  const tasks = useBoardStore((s) => s.tasks);
  const filters = useBoardStore((s) => s.filters);
  const online = useBoardStore((s) => s.online);

  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [draggedTaskHeight, setDraggedTaskHeight] = useState(0);
  const [dropTargetStatus, setDropTargetStatus] = useState<string | null>(null);
  const [movingTaskId, setMovingTaskId] = useState<string | null>(null);
  const [settlingTaskId, setSettlingTaskId] = useState<string | null>(null);
  const settlingTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => {
    if (settlingTimer.current !== undefined) clearTimeout(settlingTimer.current);
  }, []);

  // 筛选后的列内按 sortOrder 升序（与 db list_tasks 排序一致）
  const sorted = [...tasks]
    .filter((t) => matchesTaskFilters(t, filters, 'statuses')) // 状态列已表达状态筛选？——
    // 上游语义：状态筛选时只显示所选列（列即状态）；此处过滤掉未选状态的整列
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt));
  const columns = columnsOf(sorted);

  async function handleDrop(status: string, taskId: string, beforeTaskId: string | null) {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;

    // 落点 sortOrder：前/后卡中值（对齐上游 drag-drop 计算惯例）
    const columnTasks = (columns[status] ?? []).filter((t) => t.id !== taskId);
    let sortOrder: number;
    if (beforeTaskId) {
      const idx = columnTasks.findIndex((t) => t.id === beforeTaskId);
      if (idx === 0) {
        sortOrder = columnTasks[0].sortOrder - 1000;
      } else if (idx > 0) {
        const before = columnTasks[idx - 1].sortOrder;
        const after = columnTasks[idx].sortOrder;
        sortOrder = (before + after) / 2;
      } else {
        sortOrder = (columnTasks[columnTasks.length - 1]?.sortOrder ?? 0) + 1000;
      }
    } else {
      sortOrder = (columnTasks[columnTasks.length - 1]?.sortOrder ?? 0) + 1000;
    }

    // 状态没变且落点即原位 → 无操作（避免无意义 version+1）
    if (task.status === status && Math.abs(task.sortOrder - sortOrder) < 0.001) return;

    // 撤销快照须在写操作前捕获（写路径可能原地变更对象，await 后再读会拿到新值）
    const origStatus = task.status;
    const origSortOrder = task.sortOrder;

    setMovingTaskId(taskId);
    try {
      await invoke('move_task', { id: taskId, version: task.version, status, sortOrder });
      await loadBoardData();
      // 数据落地 → moving 转 settling（一次轻高亮后沉淀）
      setMovingTaskId(null);
      setSettlingTaskId(taskId);
      if (settlingTimer.current !== undefined) clearTimeout(settlingTimer.current);
      settlingTimer.current = window.setTimeout(() => setSettlingTaskId(null), 220);
      // 撤销注册：回滚到原状态与原位置
      pushUndo({
        label: `已撤销：${task.identifier} 回 ${origStatus}`,
        undo: () =>
          invoke('move_task', { id: taskId, version: useBoardStore.getState().tasks.find((t) => t.id === taskId)?.version ?? 1, status: origStatus, sortOrder: origSortOrder })
            .then(() => loadBoardData()),
      });
    } catch (e) {
      setMovingTaskId(null);
      if (isCommandError(e) && e.code === 'VERSION_CONFLICT') {
        // 冲突：重读一次再试（对齐 mini moveTask 的单次重试语义）
        try {
          await loadBoardData();
          const fresh = useBoardStore.getState().tasks.find((t) => t.id === taskId);
          if (fresh) {
            await invoke('move_task', { id: taskId, version: fresh.version, status, sortOrder });
            await loadBoardData();
            setSettlingTaskId(taskId);
            settlingTimer.current = window.setTimeout(() => setSettlingTaskId(null), 220);
            return;
          }
          throw new Error('任务已被删除，流转未生效');
        } catch (retryErr) {
          console.error('move retry failed', retryErr);
          showToast(errMsg(retryErr, '任务刚被外部修改，请重试'), true);
        }
      } else {
        console.error('move failed', e);
        showToast(errMsg(e, '流转失败'), true);
      }
    } finally {
      setDraggedTaskId(null);
      setDropTargetStatus(null);
    }
  }

  if (!online) {
    return <div className="fb-offline">数据层不可用，正在重试…</div>;
  }

  return (
    <div className="fb-board">
      {BOARD_COLUMNS.map((status) => (
        <BoardColumn
          key={status}
          status={status}
          tasks={columns[status]}
          isDropTarget={dropTargetStatus === status && draggedTaskId !== null}
          draggedTaskId={draggedTaskId}
          draggedTaskHeight={draggedTaskHeight}
          movingTaskId={movingTaskId}
          settlingTaskId={settlingTaskId}
          onCardClick={onCardClick}
          onContextMenu={onContextMenu}
          onDragStart={(task, height) => {
            setDraggedTaskId(task.id);
            setDraggedTaskHeight(height);
          }}
          onDragEnd={() => {
            setDraggedTaskId(null);
            setDropTargetStatus(null);
          }}
          onDragEnter={setDropTargetStatus}
          onDrop={handleDrop}
        />
      ))}
    </div>
  );
}
