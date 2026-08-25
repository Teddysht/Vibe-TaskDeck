/* ============================================================
 * 状态计数条 —— 首格「全部」是筛选唯一复位入口（移植自 render-large.js）
 * 契约：#counts、.c[data-s]、.on、blocked 格 danger 色
 * （快捷看板移除后常驻显示，hidden prop 仅作兼容占位）
 * ============================================================ */
import { useAppStore } from '../store/useAppStore';
import { STATUS_LABEL, STATUS_ORDER } from '../lib/types';

export default function CountsBar({ hidden = false }: { hidden?: boolean }) {
  const tasks = useAppStore((s) => s.tasks);
  const filter = useAppStore((s) => s.filter);
  const setFilter = useAppStore((s) => s.setFilter);

  const map: Record<string, number> = {};
  tasks.forEach((t) => {
    map[t.status] = (map[t.status] || 0) + 1;
  });

  return (
    <div className="counts" id="counts" style={{ display: hidden ? 'none' : undefined }}>
      <div
        className={`c${filter === 'all' ? ' on' : ''}`}
        data-s="all"
        role="button"
        tabIndex={0}
        onClick={() => setFilter('all')}
      >
        <div className="n">{tasks.length}</div>
        <div className="l">全部</div>
      </div>
      {STATUS_ORDER.map((s) => (
        <div
          key={s}
          className={`c${s === 'blocked' ? ' danger' : ''}${filter === s ? ' on' : ''}`}
          data-s={s}
          role="button"
          tabIndex={0}
          onClick={() => setFilter(s)}
        >
          <div className="n">{map[s] || 0}</div>
          <div className="l">{STATUS_LABEL[s]}</div>
        </div>
      ))}
    </div>
  );
}
