/* ============================================================
 * 看板列 —— 拖拽开缝方案对齐 upstream BoardColumn.tsx：
 *   · dropBeforeTaskId = 指针 Y 与各卡 rect 中线比较
 *   · 其余卡 translate3d 开缝（源列上方卡上移 / 目标列下方卡下移）
 *   · moving/settling 两阶段置后动画（掩盖 SQLite 往返延迟）
 * ============================================================ */
import { useEffect, useState } from 'react';
import type { DragEvent } from 'react';
import type { Task } from '../../lib/types';
import TaskCard, { CARD_GAP } from './TaskCard';
import { COLUMN_LABEL } from '../store/useBoardStore';

interface Props {
  status: string;
  tasks: Task[]; // 已按 sortOrder 排序
  isDropTarget: boolean;
  draggedTaskId: string | null;
  draggedTaskHeight: number;
  movingTaskId: string | null;
  settlingTaskId: string | null;
  onCardClick: (task: Task) => void;
  onContextMenu: (task: Task, x: number, y: number) => void;
  onDragStart: (task: Task, height: number) => void;
  onDragEnd: () => void;
  onDragEnter: (status: string) => void;
  onDrop: (status: string, taskId: string, beforeTaskId: string | null) => void;
}

export default function BoardColumn({
  status,
  tasks,
  isDropTarget,
  draggedTaskId,
  draggedTaskHeight,
  movingTaskId,
  settlingTaskId,
  onCardClick,
  onContextMenu,
  onDragStart,
  onDragEnd,
  onDragEnter,
  onDrop,
}: Props) {
  const [dropBeforeTaskId, setDropBeforeTaskId] = useState<string | null | undefined>();

  const taskIndexes = new Map(tasks.map((t, i) => [t.id, i]));
  const remaining = tasks.filter((t) => t.id !== draggedTaskId);
  const remainingIndexes = new Map(remaining.map((t, i) => [t.id, i]));
  const draggedIndex = draggedTaskId ? taskIndexes.get(draggedTaskId) ?? -1 : -1;
  const beforeIndex = dropBeforeTaskId
    ? remainingIndexes.get(dropBeforeTaskId) ?? remaining.length
    : remaining.length;
  const previewIndex = isDropTarget && dropBeforeTaskId !== undefined ? beforeIndex : -1;
  const dragDistance = draggedTaskHeight + CARD_GAP;

  useEffect(() => {
    if (!isDropTarget || !draggedTaskId) setDropBeforeTaskId(undefined);
  }, [draggedTaskId, isDropTarget]);

  function findDropBefore(container: HTMLElement, clientY: number): string | null {
    const cards = Array.from(container.querySelectorAll<HTMLElement>('[data-task-id]')).filter(
      (card) => card.dataset.taskId !== draggedTaskId,
    );
    return (
      cards.find((card) => clientY < card.getBoundingClientRect().top + card.offsetHeight / 2)
        ?.dataset.taskId ?? null
    );
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    const taskId =
      event.dataTransfer.getData('application/x-taskboard-task') ||
      event.dataTransfer.getData('text/plain');
    if (taskId) onDrop(status, taskId, findDropBefore(event.currentTarget, event.clientY));
    setDropBeforeTaskId(undefined);
  }

  function getTaskDragShift(task: Task): number {
    if (!draggedTaskId || task.id === draggedTaskId) return 0;
    let shift = 0;
    const taskIndex = taskIndexes.get(task.id) ?? -1;
    const remainingIndex = remainingIndexes.get(task.id) ?? -1;
    if (draggedIndex >= 0 && taskIndex > draggedIndex) shift -= dragDistance;
    if (previewIndex >= 0 && remainingIndex >= previewIndex) shift += dragDistance;
    return shift;
  }

  return (
    <section
      className={`fb-col${isDropTarget ? ' is-drop-target' : ''}`}
      data-status={status}
      onDragEnter={() => onDragEnter(status)}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        onDragEnter(status);
        setDropBeforeTaskId(findDropBefore(event.currentTarget, event.clientY));
      }}
      onDragLeave={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
          setDropBeforeTaskId(undefined);
        }
      }}
      onDrop={handleDrop}
    >
      <header className="col-header">
        <span className={`col-dot st-${status}`} aria-hidden="true" />
        <h2 className="col-title">{COLUMN_LABEL[status]}</h2>
        <span className="col-count">{tasks.length}</span>
      </header>
      <div className="col-list">
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            isDragging={draggedTaskId === task.id}
            dragShift={getTaskDragShift(task)}
            isMoving={movingTaskId === task.id}
            isSettling={settlingTaskId === task.id}
            onClick={onCardClick}
            onContextMenu={onContextMenu}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
          />
        ))}
        {tasks.length === 0 && <div className="col-empty">空</div>}
      </div>
    </section>
  );
}
