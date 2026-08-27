/* ============================================================
 * 仪表盘视图 —— 对齐上游 Dashboard 的功能语义（项目完成度）。
 * 图表：recharts（shadcn charts 官方底座），shadcn ChartTooltip 风格。
 * 布局：auto-fit grid 动态适配（≥2 列卡片并排 → 窄窗单列堆叠），
 *       图表用 ResponsiveContainer 随容器伸缩。
 * 数据全部从 store 派生（零后端改动）。
 * ============================================================ */
import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  RadialBar,
  RadialBarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { PRI_LABEL, STATUS_LABEL, STATUS_ORDER } from '../../lib/types';
import { localDate } from '../../lib/format';
import type { Task } from '../../lib/types';
import { isOverdue, shortDate } from '../../lib/format';
import { useBoardStore } from '../store/useBoardStore';

// 状态色（与看板列 col-dot 同源；recharts 需实际色值）
const STATUS_HEX: Record<string, string> = {
  backlog: '#353842',
  todo: '#9ca3af',
  in_progress: '#6e8bff',
  in_review: '#c084fc',
  done: '#3fb877',
  blocked: '#ef5046',
  canceled: '#82868f',
};

// shadcn ChartTooltip 风格：card 底 + border + shadow
function ChartTip({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number | string; color?: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="fb-chart-tip">
      {label !== undefined && <div className="t">{label}</div>}
      {payload.map((p, i) => (
        <div key={i} className="item">
          <span className="dot" style={{ background: p.color }} />
          {p.name} <b>{p.value}</b>
        </div>
      ))}
    </div>
  );
}

export default function DashboardView({ onGotoColumn }: { onGotoColumn: (status: string) => void }) {
  const tasks = useBoardStore((s) => s.tasks);
  const online = useBoardStore((s) => s.online);

  const model = useMemo(() => {
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

    // 近 7 天创建 + 完成（双序列面积）。createdAt/completedAt 是 UTC ISO，
    // 分桶必须换算到本地日期——直接切串会把凌晨的事记到前一天柱子上。
    const now = new Date();
    const dayKey = (iso?: string | null): string => (iso ? localDate(new Date(iso)) : '');
    const trend: Array<{ day: string; 创建: number; 完成: number }> = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = localDate(d);
      trend.push({
        day: `${d.getMonth() + 1}/${d.getDate()}`,
        创建: live.filter((t) => dayKey(t.createdAt) === key).length,
        完成: done.filter((t) => dayKey((t as Task & { completedAt?: string }).completedAt) === key).length,
      });
    }

    // 3 天内到期（含逾期）清单（日期串比较，避免 UTC 解析与时区错位）
    const horizon = new Date(now);
    horizon.setDate(horizon.getDate() + 3);
    const horizonYmd = localDate(horizon);
    const upcoming = live
      .filter((t) => {
        if (t.status === 'done' || t.status === 'canceled' || !t.dueDate) return false;
        return t.dueDate <= horizonYmd;
      })
      .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''))
      .slice(0, 5);

    return { live, byStatus, done, inReview, blocked, overdue, agent, total, pct, trend, upcoming };
  }, [tasks]);

  if (!online) {
    return <div className="fb-offline">数据层不可用，正在重试…</div>;
  }

  const { byStatus, done, inReview, blocked, overdue, agent, total, pct, trend, upcoming } = model;

  // 环图数据（recharts RadialBar：完成度单环）
  const ring = [{ name: '完成度', value: pct, fill: pct >= 80 ? '#3fb877' : pct >= 40 ? '#6e8bff' : '#8fa2ff' }];

  return (
    <div className="fb-dash">
      {/* ---- 第一行：完成度环图 + 状态分布（宽窗双卡并排） ---- */}
      <div className="fb-dash-row">
        <section className="fb-dash-card fb-dash-hero">
          <div className="card-hd">项目完成度</div>
          <div className="hero-flex">
            <div className="hero-ring">
              <ResponsiveContainer width="100%" height="100%">
                <RadialBarChart
                  data={ring}
                  innerRadius="72%"
                  outerRadius="100%"
                  startAngle={90}
                  endAngle={-270}
                  barSize={14}
                >
                  <RadialBar background={{ fill: 'var(--bg-surface-2)' }} dataKey="value" cornerRadius={7} />
                  <Tooltip content={<ChartTip />} />
                </RadialBarChart>
              </ResponsiveContainer>
              <div className="ring-center">
                <strong>{pct}</strong>
                <span>%</span>
              </div>
            </div>
            <div className="hero-meta">
              <div className="big-line">
                <span className="n">{done.length}</span> 已完成 ·
                <span className="n">{total - done.length}</span> 尚未结束
              </div>
              {/* 分布条：七状态分段 */}
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
                        style={{ background: STATUS_HEX[s], flexGrow: n }}
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
                      <span className="dot" style={{ background: STATUS_HEX[s] }} />
                      {STATUS_LABEL[s]} {byStatus.get(s)!.length}
                    </button>
                  ))}
              </div>
            </div>
          </div>
        </section>

        {/* ---- 近 7 天趋势：双序列面积图 ---- */}
        <section className="fb-dash-card fb-dash-trend">
          <div className="card-hd">近 7 天动态</div>
          <div className="trend-chart">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trend} margin={{ top: 8, right: 4, bottom: 0, left: -22 }}>
                <defs>
                  <linearGradient id="g-create" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#6e8bff" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#6e8bff" stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient id="g-done" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#3fb877" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="#3fb877" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="day"
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 10, fill: 'var(--text-weak)' }}
                  interval="preserveStartEnd"
                />
                <YAxis
                  allowDecimals={false}
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 10, fill: 'var(--text-weak)' }}
                  width={36}
                />
                <Tooltip content={<ChartTip />} cursor={{ stroke: 'var(--border-subtle)' }} />
                <Area type="monotone" dataKey="创建" stroke="#6e8bff" strokeWidth={2} fill="url(#g-create)" />
                <Area type="monotone" dataKey="完成" stroke="#3fb877" strokeWidth={2} fill="url(#g-done)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div className="trend-cap">
            <span className="cap-item"><span className="dot" style={{ background: '#6e8bff' }} />创建 {trend.reduce((n, d) => n + d.创建, 0)}</span>
            <span className="cap-item"><span className="dot" style={{ background: '#3fb877' }} />完成 {trend.reduce((n, d) => n + d.完成, 0)}</span>
          </div>
        </section>
      </div>

      {/* ---- 第二行：关注 / 人机 / 优先级（auto-fit 动态列） ---- */}
      <div className="fb-dash-grid">
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

        <section className="fb-dash-card">
          <div className="card-hd">人机协作</div>
          <div className="fb-dash-ratio">
            <div className="track">
              <span className="agent" style={{ flexGrow: agent.length }} />
              <span className="user" style={{ flexGrow: total - agent.length }} />
            </div>
            <div className="cap">
              <span className="cap-item">
                <span className="ag">AG</span> AI 创建 {agent.length}（{total ? Math.round((agent.length / total) * 100) : 0}%）
              </span>
              <span className="cap-item">用户 {total - agent.length}</span>
            </div>
          </div>
          <div className="fb-dash-pri">
            {(['urgent', 'high', 'medium', 'low'] as const)
              .map((p) => ({ p, n: model.live.filter((t) => t.priority === p).length }))
              .filter((x) => x.n > 0)
              .map(({ p, n }) => (
                <button key={p} className={`pri-chip pri-${p}`} onClick={() => onGotoColumn('')}>
                  {PRI_LABEL[p]} {n}
                </button>
              ))}
            {model.live.every((t) => t.priority === 'none') && <span className="fb-dash-none">未设置优先级</span>}
          </div>
        </section>
      </div>
    </div>
  );
}
