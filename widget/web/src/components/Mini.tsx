/* ============================================================
 * Mini 胶囊（280×48）—— 移植自 render-mini.js + index.html
 * 契约：DOM id 全保留（#mini #miniShape #miniBody #miniT #miniMeta
 * #miniPri #expandBtn #miniDots）；swap 动画经 reflow 重启。
 * ============================================================ */
import { useEffect, useRef } from 'react';
import { isOverdue, priBadge, shapeClass, shortDate } from '../lib/format';
import { useAppStore } from '../store/useAppStore';
import { PRI_LABEL, STATUS_LABEL } from '../lib/types';

interface Props {
  hidden: boolean;
  entering: boolean; // .entering 类（收起完成后的淡入段）
  onExpand: () => void;
}

// 轮播指示可见窗口大小（序列超此时窗口化：当前项居中 + 两端渐隐）
const WINDOW = 7;

export default function Mini({ hidden, entering, onExpand }: Props) {
  const online = useAppStore((s) => s.online);
  const tasks = useAppStore((s) => s.tasks);
  const seq = useAppStore((s) => s.seq);
  const idx = useAppStore((s) => s.idx);
  const setIdx = useAppStore((s) => s.setIdx);

  const bodyRef = useRef<HTMLDivElement>(null);
  const lastShownId = useRef<string | null>(null);

  const item = seq[idx] as (typeof seq)[number] | undefined;

  // 轮转切换到不同任务时给一次轻过渡（同一任务的数据刷新不打扰）
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !item) return;
    if (item.id !== lastShownId.current) {
      body.classList.remove('swap');
      void body.offsetWidth; // 强制 reflow 以重启动画
      body.classList.add('swap');
      lastShownId.current = item.id;
    }
  }, [item?.id]); // eslint-disable-line react-hooks/exhaustive-deps -- 只看任务 id 变化

  let shape = 'shape idle';
  let title = '—';
  let meta: React.ReactNode = '';
  let metaOverdue = false;
  let badge: string | null = null;

  if (!online) {
    shape = 'shape idle';
    title = '数据层不可用';
    meta = '正在重试…';
  } else if (!seq.length) {
    shape = 'shape idle';
    if (tasks.length) {
      title = '任务都处理完了';
      meta = '当前没有需要关注的任务';
    } else {
      title = '还没有任务';
      meta = '展开后点击「新建任务」创建';
    }
  } else if (item) {
    shape = `shape ${shapeClass(item.status)}`;
    title = item.title;
    const due = shortDate(item.dueDate);
    meta = (
      <>
        {item.creatorType === 'agent' && (
          <span className="ag" title="AI 会话创建">AI</span>
        )}
        {item.identifier} · {STATUS_LABEL[item.status]}
        {due ? ` · ${due}` : ''}
      </>
    );
    metaOverdue = isOverdue(item.dueDate);
    badge = priBadge(item.priority);
  }

  return (
    <div
      className={`mini${entering ? ' entering' : ''}`}
      id="mini"
      style={{ display: hidden ? 'none' : 'flex' }}
      role="button"
      tabIndex={0}
      title="展开任务看板"
      onClick={onExpand}
    >
      <div className={shape} id="miniShape" />
      <div className="body" id="miniBody" ref={bodyRef}>
        <div className="t" id="miniT">{title}</div>
        <div className={`meta${metaOverdue ? ' overdue' : ''}`} id="miniMeta">
          {meta}
        </div>
      </div>
      <div
        className={`pri${badge === 'urgent' ? ' urgent' : badge === 'high' ? ' high' : ''}`}
        id="miniPri"
        style={{ display: badge ? undefined : 'none' }}
      >
        {badge ? (PRI_LABEL[badge] ?? '') : ''}
      </div>
      <div
        className="expand"
        id="expandBtn"
        title="展开"
        role="button"
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation();
          onExpand();
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 14l5-5 5 5" /></svg>
      </div>
      {/* 轮播指示：窗口化滑轨（业界标准做法，对齐 Safari 标签页/iOS 页码点）。
          序列 ≤WINDOW 段时完整显示；超限只显示当前项 ±邻域共 WINDOW 段，
          两端渐隐遮罩暗示序列延伸。刻度总数恒定，任意序列长度永不贴边。 */}
      <div
        className="dots"
        id="miniDots"
        onClick={(e) => {
          e.stopPropagation(); // 点指示点不触发展开
          const i = (e.target as HTMLElement).dataset.i;
          if (i !== undefined) setIdx(Number(i));
        }}
      >
        {(() => {
          // 计算可见窗口 [start, start+WINDOW)，当前项尽量居中
          const half = Math.floor(WINDOW / 2);
          let start = Math.max(0, Math.min(idx - half, seq.length - WINDOW));
          const visible = seq.length <= WINDOW
            ? seq.map((_, i) => i)
            : Array.from({ length: WINDOW }, (_, k) => start + k);
          const windowed = seq.length > WINDOW;
          return visible.map((i) => (
            <i
              key={i}
              className={[
                i === idx ? 'on' : '',
                // 窗口两端且非序列首尾 → 渐隐刻度（暗示还有更多）
                windowed && i === start && start > 0 ? 'fade-l' : '',
                windowed && i === start + WINDOW - 1 && i < seq.length - 1 ? 'fade-r' : '',
              ].filter(Boolean).join(' ')}
              data-i={i}
              title={windowed ? `第 ${i + 1} 个，共 ${seq.length} 个任务` : `${i + 1}/${seq.length}`}
            />
          ));
        })()}
      </div>
    </div>
  );
}
