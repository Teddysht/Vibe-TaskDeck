/* ============================================================
 * 任务列表 —— 筛选后的行渲染（移植自 render-large.js）
 * 契约：#list、.item[data-id] role=button、.act button[data-a]
 * ============================================================ */
import { moveTask } from '../lib/api';
import { boardActions } from '../lib/actions';
import { errMsg, showToast } from '../lib/toast';
import { isOverdue, priBadge, shapeClass, shortDate } from '../lib/format';
import { useAppStore } from '../store/useAppStore';
import { PRI_LABEL } from '../lib/types';
import type { Task } from '../lib/types';

async function onQuickMove(task: Task, status: string, btn: HTMLButtonElement) {
  btn.disabled = true;
  try {
    await moveTask(task, status);
  } catch (err) {
    console.error('move failed', err);
    showToast(errMsg(err, '流转失败'), true);
  } finally {
    btn.disabled = false;
  }
}

export default function TaskList({ hidden = false }: { hidden?: boolean }) {
  const tasks = useAppStore((s) => s.tasks);
  const filter = useAppStore((s) => s.filter);
  const online = useAppStore((s) => s.online);
  const openDetail = useAppStore((s) => s.openDetail);

  const rows = tasks.filter((t) => filter === 'all' || t.status === filter);

  return (
    <div className="list" id="list" style={{ display: hidden ? 'none' : undefined }}>
      {online &&
        rows.map((t) => {
          const dim = t.status === 'done' || t.status === 'canceled';
          const badge = priBadge(t.priority);
          const due = shortDate(t.dueDate);
          return (
            <div
              key={t.id}
              className={`item${dim ? ' dim' : ''}`}
              data-id={t.id}
              role="button"
              tabIndex={0}
              onClick={() => openDetail(t.id)}
            >
              <div className={`shape ${shapeClass(t.status)}`} />
              <div className="mid">
                <div className="t">{t.title}</div>
                <div className="m">
                  {t.creatorType === 'agent' && (
                    <span className="ag" title="AI 会话创建">AI</span>
                  )}
                  {t.identifier}
                  {due && (
                    <>
                      {' · '}
                      <span className={isOverdue(t.dueDate) ? 'overdue' : undefined}>{due}</span>
                    </>
                  )}
                </div>
              </div>
              {badge && (
                <div className={`pri ${badge}`}>{PRI_LABEL[badge]}</div>
              )}
              <div className="act">
                {boardActions(t).map((a) => (
                  <button
                    key={a.s}
                    className={a.primary ? 'primary' : undefined}
                    data-a={a.s}
                    onClick={(e) => {
                      e.stopPropagation();
                      onQuickMove(t, a.s, e.currentTarget);
                    }}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
    </div>
  );
}
