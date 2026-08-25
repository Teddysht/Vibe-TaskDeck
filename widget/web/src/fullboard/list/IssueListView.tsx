/* ============================================================
 * 列表视图 —— 表格态（对齐上游 IssueListView：identifier/标题/状态/
 * 优先级/截止/创建者；行点击进详情）
 * ============================================================ */
import { PRI_LABEL, STATUS_LABEL } from '../../lib/types';
import type { Task } from '../../lib/types';
import { isOverdue, shortDate } from '../../lib/format';
import { useBoardStore } from '../store/useBoardStore';

export default function IssueListView({ onRowClick }: { onRowClick: (task: Task) => void }) {
  const tasks = useBoardStore((s) => s.tasks);
  const online = useBoardStore((s) => s.online);

  if (!online) {
    return <div className="fb-offline">数据层不可用，正在重试…</div>;
  }

  const rows = tasks.filter((t) => !t.archivedAt);

  return (
    <div className="fb-list">
      <div className="fb-list-head">
        <span>ID</span><span>标题</span><span>状态</span><span>优先级</span><span>截止</span><span>创建者</span>
      </div>
      <div className="fb-list-body">
        {rows.map((t) => (
          <div key={t.id} className="fb-list-row" data-task-id={t.id} onClick={() => onRowClick(t)}>
            <span className="c-id">{t.identifier}</span>
            <span className="c-title">
              {t.creatorType === 'agent' && <span className="ag" title="AI 会话创建">AI</span>}
              {t.title}
            </span>
            <span className="c-status">{STATUS_LABEL[t.status] || t.status}</span>
            <span className="c-pri">{t.priority !== 'none' ? PRI_LABEL[t.priority] : '—'}</span>
            <span className={`c-due${isOverdue(t.dueDate) && t.status !== 'done' ? ' overdue' : ''}`}>
              {shortDate(t.dueDate) || '—'}
            </span>
            <span className="c-creator">{t.creatorName}</span>
          </div>
        ))}
        {rows.length === 0 && <div className="fb-list-empty">没有匹配的任务</div>}
      </div>
    </div>
  );
}
