/* ============================================================
 * 筛选栏 —— 搜索框（/ 聚焦）+ 状态/优先级多选 + 清除按钮
 * 筛选状态写 URL（writeTaskFilters），板/列表两视图共享。
 * ============================================================ */
import { useEffect, useRef } from 'react';
import { PRI_LABEL, STATUS_LABEL, STATUS_ORDER } from '../../lib/types';
import { taskFilterCount, type TaskFilters } from '../taskFilters';
import { useBoardStore } from '../store/useBoardStore';

const PRI_ORDER = ['urgent', 'high', 'medium', 'low', 'none'];

export default function FilterBar() {
  const filters = useBoardStore((s) => s.filters);
  const setFilters = useBoardStore((s) => s.setFilters);
  const projects = useBoardStore((s) => s.projects);
  const searchRef = useRef<HTMLInputElement>(null);

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

  function apply(patch: Partial<TaskFilters>) {
    const next = { ...filters, ...patch };
    setFilters(next);
    import('../taskFilters').then(({ writeTaskFilters }) => writeTaskFilters(next));
  }

  function toggleIn(list: string[], v: string): string[] {
    return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
  }

  const catalog = projects[0]?.labels ?? [];
  const active = taskFilterCount(filters);

  return (
    <div className="fb-filterbar" data-testid="filterbar">
      <input
        ref={searchRef}
        id="fb-search"
        className="fb-search"
        placeholder="搜索任务…（/ 聚焦）"
        defaultValue={filters.content}
        onChange={(e) => apply({ content: e.target.value })}
      />
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
      {catalog.length > 0 && (
        <div className="fb-chips" role="group" aria-label="标签筛选">
          {catalog.slice(0, 8).map((l) => (
            <button
              key={l}
              className={`fb-chip${filters.labels.includes(l) ? ' on' : ''}`}
              onClick={() => apply({ labels: toggleIn(filters.labels, l) })}
            >
              {l}
            </button>
          ))}
        </div>
      )}
      {active > 0 && (
        <button className="fb-clear" onClick={() => apply({ statuses: [], priorities: [], labels: [], content: '' })}>
          清除筛选（{active}）
        </button>
      )}
    </div>
  );
}
