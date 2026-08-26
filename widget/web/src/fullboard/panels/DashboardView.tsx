/* ============================================================
 * 仪表盘视图 —— 对齐上游 Dashboard 的功能语义（项目完成度），
 * 视觉用本项目 shadcn 语言（Card/Badge/Progress/Avatar 同构）。
 * 数据全部从 store 派生（零后端改动）：
 * · 完成度大数字（done / 未归档总数）
 * · 七状态分布条（分段进度，非独立进度条——状态间是整体占比关系）
 * · 需要关注：逾期 / 待评审 / 阻塞（可点击跳看板对应列）
 * · 最近 7 天创建趋势（迷你柱状，无图表库——纯 div 高度）
 * · 人机分布（AI vs 用户创建占比——产品定位的核心信号）
 * ============================================================ */
import { PRI_LABEL, STATUS_LABEL, STATUS_ORDER } from '../../lib/types';
import type { Task } from '../../lib/types';
import { isOverdue, shortDate } from '../../lib/format';
import { useBoardStore } from '../store/useBoardStore';

// 状态点配色（与看板列 col-dot 同源）
const STATUS_COLOR: Record<string, string> = {
  backlog: 'var(--gray-5)',
  todo: '#9ca3af',
  in_progress: 'var(--brand-500)',
  in_review: '#c084fc',
  done: 'var(--success)',
  blocked: 'var(--danger)',
  canceled: 'var(--gray-6)',
};

export default function DashboardView({ onGotoColumn }: { onGotoColumn: (status: string) => void }) {
  const tasks = useBoardStore((s) => s.tasks);
  const online = useBoardStore((s) => s.online);

  if (!online) {
    return <div className="fb-offline">数据层不可用，正在重试…</div>;
  }

  const live = tasks.filter((t) => !t.archivedAt);
  const byStatus = new Map<string, Task[]>();
  for (const t of live) {
    const list = byStatus.get(t.status) ?? [];
    list.push(t);
    byStatus.set(t.status, list);
  }
  const done = byStatus.get('done') ?? [];
  const inReview = byStatus.get('in_review') ?? [];
  const blocked = byStatus.get('blocked') ?? [];
  const overdue = live.filter((t) => isOverdue(t.dueDate) && t.status !== 'done' && t.status !== 'canceled');
  const agent = live.filter((t) => t.creatorType === 'agent');

  const total = live.length;
  const pct = total === 0 ? 0 : Math.round((done.length / total) * 100);

  // 最近 7 天创建趋势（含今天）
  const days: Array<{ label: string; count: number }> = [];
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    days.push({
      label: `${d.getMonth() + 1}/${d.getDate()}`,
      count: live.filter((t) => t.createdAt?.slice(0, 10) === key).length,
    });
  }
  const maxCount = Math.max(1, ...days.map((d) => d.count));

  // 最近即将到期（未来 3 天内到期且未完成）
  const upcoming = live
    .filter((t) => {
      if (t.status === 'done' || t.status === 'canceled' || !t.dueDate) return false;
      const due = new Date(t.dueDate).getTime();
      const diff = (due - now.getTime()) / 86400000;
      return diff <= 3; // 含逾期
    })
    .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''))
    .slice(0, 5);

  return (
    <div className="fb-dash">
      {/* ---- 完成度主卡（上游 dashboard-heading 同位） ---- */}
      <section className="fb-dash-hero">
        <header>
          <h1>项目完成度</h1>
          <span className="sub">
            {done.length} 个已完成 · {total - done.length} 个尚未结束
          </span>
        </header>
        <div className="hero-value">
          <strong>{pct}</strong>
          <span className="pct">%</span>
        </div>
        {/* 分布条：七状态分段（整体 100% 占比关系） */}
        <div className="fb-dash-bar" role="img" aria-label={`完成度 ${pct}%`}>
          {total === 0 ? (
            <span className="empty-track" />
          ) : (
            STATUS_ORDER.concat('canceled').map((s) => {
              const n = byStatus.get(s)?.length ?? 0;
              if (n === 0) return null;
              return (
                <button
                  key={s}
                  className="seg"
                  style={{ background: STATUS_COLOR[s], flexGrow: n }}
                  title={`${STATUS_LABEL[s]} ${n}`}
                  onClick={() => onGotoColumn(s)}
                />
              );
            })
          )}
        </div>
        <div className="fb-dash-legend">
          {STATUS_ORDER.concat('canceled')
            .filter((s) => (byStatus.get(s)?.length ?? 0) > 0)
            .map((s) => (
              <button key={s} className="lg" onClick={() => onGotoColumn(s)} title={`查看 ${STATUS_LABEL[s]}列`}>
                <span className="dot" style={{ background: STATUS_COLOR[s] }} />
                {STATUS_LABEL[s]} {byStatus.get(s)!.length}
              </button>
            ))}
        </div>
      </section>

      <div className="fb-dash-grid">
        {/* ---- 需要关注 ---- */}
        <section className="fb-dash-card">
          <div className="card-hd">需要关注</div>
          <div className="fb-dash-stats">
            <button className="stat danger" onClick={() => onGotoColumn('')} disabled={overdue.length === 0}>
              <span className="n">{overdue.length}</span>
              <span className="l">已逾期</span>
            </button>
            <button className="stat" onClick={() => onGotoColumn('in_review')} disabled={inReview.length === 0}>
              <span className="n">{inReview.length}</span>
              <span className="l">待评审</span>
            </button>
            <button className="stat danger" onClick={() => onGotoColumn('blocked')} disabled={blocked.length === 0}>
              <span className="n">{blocked.length}</span>
              <span className="l">阻塞</span>
            </button>
          </div>
          {/* 即将到期清单（3 天内 + 逾期） */}
          {upcoming.length > 0 && (
            <div className="fb-dash-list">
              {upcoming.map((t) => {
                const od = isOverdue(t.dueDate) && t.status !== 'done';
                return (
                  <button key={t.id} className="row" onClick={() => onGotoColumn(t.status)}>
                    <span className="tref">{t.identifier}</span>
                    <span className="tt">{t.title}</span>
                    <span className={`due${od ? ' od' : ''}`}>{shortDate(t.dueDate)}</span>
                  </button>
                );
              })}
            </div>
          )}
          {total === 0 && <div className="fb-dash-none">还没有任务——点右上「新建」开始</div>}
        </section>

        {/* ---- 近 7 天创建趋势 ---- */}
        <section className="fb-dash-card">
          <div className="card-hd">近 7 天创建</div>
          <div className="fb-dash-chart" role="img" aria-label="最近七天创建任务数">
            {days.map((d) => (
              <div key={d.label} className="col" title={`${d.label}：${d.count} 个`}>
                <span className="bar" style={{ height: `${(d.count / maxCount) * 100}%` }} />
                <span className="n">{d.count > 0 ? d.count : ''}</span>
                <span className="l">{d.label}</span>
              </div>
            ))}
          </div>
          <div className="fb-dash-foot">
            共 {days.reduce((n, d) => n + d.count, 0)} 个新任务
          </div>
        </section>

        {/* ---- 人机分布（产品定位信号） ---- */}
        <section className="fb-dash-card">
          <div className="card-hd">人机协作</div>
          <div className="fb-dash-ratio">
            <div className="track">
              <span className="agent" style={{ flexGrow: agent.length }} />
              <span className="user" style={{ flexGrow: total - agent.length }} />
            </div>
            <div className="cap">
              <span className="cap-item">
                <span className="ag">AG</span> AI 创建 {agent.length}
              </span>
              <span className="cap-item">用户创建 {total - agent.length}</span>
            </div>
          </div>
          {/* 优先级速览 */}
          <div className="fb-dash-pri">
            {(['urgent', 'high', 'medium', 'low'] as const)
              .map((p) => ({ p, n: live.filter((t) => t.priority === p).length }))
              .filter((x) => x.n > 0)
              .map(({ p, n }) => (
                <button key={p} className={`pri-chip pri-${p}`} onClick={() => onGotoColumn('')}>
                  {PRI_LABEL[p]} {n}
                </button>
              ))}
            {live.every((t) => t.priority === 'none') && <span className="fb-dash-none">未设置优先级</span>}
          </div>
        </section>
      </div>
    </div>
  );
}
