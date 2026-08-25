/* ============================================================
 * 任务卡片 —— 视觉对齐 upstream TaskCard（ID 标题 优先级 标签 截止日 agent 徽标）
 * 拖拽：卡片本身 draggable，dataTransfer 携带 id；dragShift 开缝位移由列计算。
 * 状态类名沿用 upstream 语义（is-dragging is-moving is-settling）。
 * ============================================================ */
import type { Task } from '../../lib/types';
import { PRI_LABEL } from '../../lib/types';
import { isOverdue, shortDate } from '../../lib/format';

interface Props {
  task: Task;
  isDragging: boolean;
  dragShift: number;
  isMoving: boolean;
  isSettling: boolean;
  onClick: (task: Task) => void;
  onContextMenu: (task: Task, x: number, y: number) => void;
  onDragStart: (task: Task, height: number) => void;
  onDragEnd: () => void;
}

const GAP = 8; // 列内卡片间距（与列布局 gap 一致）

export default function TaskCard({
  task,
  isDragging,
  dragShift,
  isMoving,
  isSettling,
  onClick,
  onContextMenu,
  onDragStart,
  onDragEnd,
}: Props) {
  const due = shortDate(task.dueDate);
  const over = isOverdue(task.dueDate) && task.status !== 'done' && task.status !== 'canceled';
  const labels = task.labels ?? [];

  return (
    <div
      className={[
        'fb-card',
        `status-${task.status}`,
        isDragging ? 'is-dragging' : '',
        dragShift !== 0 ? 'is-drag-shifted' : '',
        isMoving ? 'is-moving' : '',
        isSettling ? 'is-settling' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-task-id={task.id}
      draggable
      style={dragShift !== 0 ? { transform: `translate3d(0, ${dragShift}px, 0)` } : undefined}
      onClick={() => onClick(task)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(task, e.clientX, e.clientY);
      }}
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-taskboard-task', task.id);
        e.dataTransfer.setData('text/plain', task.id);
        e.dataTransfer.effectAllowed = 'move';
        onDragStart(task, e.currentTarget.offsetHeight);
      }}
      onDragEnd={onDragEnd}
    >
      <div className="card-topline">
        <span className="card-reference">{task.identifier}</span>
        {task.creatorType === 'agent' && <span className="ag" title="AI 会话创建">AG</span>}
        {task.status === 'in_review' && <span className="card-status-hint">待确认</span>}
      </div>
      <div className="card-title">{task.title}</div>
      {(labels.length > 0 || task.priority !== 'none' || due) && (
        <div className="card-properties">
          {labels.slice(0, 2).map((l) => (
            <span key={l} className="label-chip">{l}</span>
          ))}
          {labels.length > 2 && <span className="label-more">+{labels.length - 2}</span>}
          {task.priority !== 'none' && (
            <span className={`pri-chip pri-${task.priority}`}>{PRI_LABEL[task.priority] || task.priority}</span>
          )}
          {due && (
            <span className={`due-chip${over ? ' overdue' : ''}`} title={`截止日期 ${due}`}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></svg>
              {due}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export const CARD_GAP = GAP;
