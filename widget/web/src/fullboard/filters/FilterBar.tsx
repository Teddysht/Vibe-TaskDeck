/* ============================================================
 * 筛选栏 —— 搜索框（/ 聚焦）+ 筛选下拉（状态/优先级/标签分组多选）。
 * 范式对齐上游/Linear：默认只露「搜索 + 筛选触发器」，已激活条件以
 * 可单独删除的胶囊显示在栏内；全量筛选项收进下拉面板。
 * 筛选状态写 URL（writeTaskFilters），板/列表两视图共享。
 * ============================================================ */
import { useEffect, useRef, useState } from 'react';
import { PRI_LABEL, STATUS_LABEL, STATUS_ORDER } from '../../lib/types';
import { type TaskFilters } from '../taskFilters';
import { useBoardStore } from '../store/useBoardStore';

const PRI_ORDER = ['urgent', 'high', 'medium', 'low', 'none'];

export default function FilterBar() {
  const filters = useBoardStore((s) => s.filters);
  const setFilters = useBoardStore((s) => s.setFilters);
  const projects = useBoardStore((s) => s.projects);
  const tasks = useBoardStore((s) => s.tasks);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  // 启动恢复 URL 筛选 + popstate 跟随
  useEffect(() => {
    const sync = () => {
      const url = new URL(window.location.href);
      const params = new URLSearchParams(url.search);
      setFilters({
        statuses: (params.get('status') ?? '').split(',').filter(Boolean),
        priorities: (params.get('priority') ?? '').split(',').filter(Boolean),
        labels: params.getAll('label').filter(Boolean),
        content: params.get('content') ?? '',
      });
    };
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 挂载一次
  }, []);

  // 面板外点关闭（mousedown，与 TaskContextMenu 同款）；Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function apply(patch: Partial<TaskFilters>) {
    const next = { ...filters, ...patch };
    setFilters(next);
    import('../taskFilters').then(({ writeTaskFilters }) => writeTaskFilters(next));
  }

  function toggleIn(list: string[], v: string): string[] {
    return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
  }

  const catalog = projects[0]?.labels ?? [];
  // 右侧统计（原型口径：总数 · 进行中数）
  const live = tasks.filter((t) => !t.archivedAt);
  const inProgress = live.filter((t) => t.status === 'in_progress').length;
  // 已激活条件（可删胶囊 + 徽标口径一致：值总数，非组数）
  const activeValues = [
    ...filters.statuses.map((s) => ({ key: 'statuses' as const, v: s, label: STATUS_LABEL[s] })),
    ...filters.priorities.map((p) => ({ key: 'priorities' as const, v: p, label: PRI_LABEL[p] || '无' })),
    ...filters.labels.map((l) => ({ key: 'labels' as const, v: l, label: l })),
  ];

  return (
    <div className="fb-filterbar" data-testid="filterbar">
      <div className="fb-searchwrap">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        <input
          ref={searchRef}
          id="fb-search"
          className="fb-search"
          placeholder="搜索任务…"
          defaultValue={filters.content}
          onChange={(e) => apply({ content: e.target.value })}
        />
        <kbd aria-hidden="true">/</kbd>
      </div>
      {/* 已激活条件：单个可删胶囊（点击即移除该值）；标签胶囊带 tag icon（原型口径：状态胶囊纯文字） */}
      {activeValues.map(({ key, v, label }) => (
        <button
          key={`${key}:${v}`}
          className="fb-chip on fb-activechip"
          title={`移除筛选：${label}`}
          onClick={() => apply({ [key]: filters[key].filter((x) => x !== v) })}
        >
          {key === 'labels' && (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20.6 13.4 12 22l-9-9V4a1 1 0 0 1 1-1h9l8.6 8.6a2 2 0 0 1 0 2.8z" /><circle cx="7.5" cy="7.5" r=".5" fill="currentColor" /></svg>
          )}
          {label}
          <span className="x" aria-hidden>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </span>
        </button>
      ))}
      <div className="fb-filterwrap" ref={menuRef}>
        <button
          id="fb-filter-btn"
          className={`fb-filterbtn${activeValues.length > 0 ? ' on' : ''}`}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />
          </svg>
          筛选
          {activeValues.length > 0 && <span className="fb-filtercount">{activeValues.length}</span>}
          <svg className="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
        </button>
        {open && (
          <div className="fb-filtermenu" data-testid="filtermenu">
            <div className="fb-fgroup">
              <div className="fb-fgtitle">状态</div>
              <div className="fb-chips" role="group" aria-label="状态筛选">
                {STATUS_ORDER.concat('canceled').map((s) => (
                  <button
                    key={s}
                    className={`fb-chip${filters.statuses.includes(s) ? ' on' : ''}`}
                    onClick={() => apply({ statuses: toggleIn(filters.statuses, s) })}
                  >
                    {STATUS_LABEL[s]}
                  </button>
                ))}
              </div>
            </div>
            <div className="fb-fgroup">
              <div className="fb-fgtitle">优先级</div>
              <div className="fb-chips" role="group" aria-label="优先级筛选">
                {PRI_ORDER.map((p) => (
                  <button
                    key={p}
                    className={`fb-chip${filters.priorities.includes(p) ? ' on' : ''}`}
                    onClick={() => apply({ priorities: toggleIn(filters.priorities, p) })}
                  >
                    {PRI_LABEL[p] || '无'}
                  </button>
                ))}
              </div>
            </div>
            {catalog.length > 0 && (
              <div className="fb-fgroup">
                <div className="fb-fgtitle">标签</div>
                <div className="fb-chips fb-flabels" role="group" aria-label="标签筛选">
                  {catalog.map((l) => (
                    <button
                      key={l}
                      className={`fb-chip${filters.labels.includes(l) ? ' on' : ''}`}
                      onClick={() => apply({ labels: toggleIn(filters.labels, l) })}
                    >
                      {l}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <button
              className="fb-clear"
              onClick={() => apply({ statuses: [], priorities: [], labels: [], content: '' })}
            >
              清除全部
            </button>
          </div>
        )}
      </div>
      <span className="fb-sum">{live.length} 个任务 · {inProgress} 个进行中</span>
    </div>
  );
}
