/* ============================================================
 * 任务详情面板 —— 右侧抽屉（对齐 upstream TaskDetail 的核心交互）
 * · 标题/优先级/状态/日期 inline 编辑（update_task）
 * · 描述 Markdown 预览 / 编辑切换
 * · 评论列表 + 发表（add_comment；Enter 发送）
 * · 活动流（issue_detail 的 activities，changes diff 渲染）
 * 数据刷新：写操作后本地 issue_detail 重拉 + Rust 事件兜底。
 * ============================================================ */
import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { invoke } from '../../lib/tauri';
import { errMsg, showToast } from '../../lib/toast';
import type { IssueDetail, Task } from '../../lib/types';
import { PRI_LABEL, STATUS_LABEL } from '../../lib/types';
import { isOverdue, shortDate, shortTime } from '../../lib/format';
import { useBoardStore } from '../store/useBoardStore';
import { loadBoardData } from '../api';
import MarkdownDocument from '../shared/MarkdownDocument';
import RelationsEditor from './RelationsEditor';
import AttachmentList from './AttachmentList';

const FIELD_LABEL: Record<string, string> = {
  title: '标题',
  description: '描述',
  status: '状态',
  priority: '优先级',
  labels: '标签',
  startDate: '开始日期',
  dueDate: '截止日期',
};

// 活动流 changes → 结构化 diff（时间线渲染用）
interface ActivityChange { field: string; before: string; after: string }
function activityChanges(changesJson: string): ActivityChange[] {
  try {
    const changes = JSON.parse(changesJson);
    if (!Array.isArray(changes)) return [];
    return changes.map((c: { field: string; before: unknown; after: unknown }) => ({
      field: FIELD_LABEL[c.field] ?? c.field,
      before: Array.isArray(c.before) ? c.before.join(',') : String(c.before ?? '—'),
      after: Array.isArray(c.after) ? c.after.join(',') : String(c.after ?? '—'),
    }));
  } catch {
    return [];
  }
}

// 状态字段的 diff 需要中文标签（存的是英文枚举）
function statusLabelOf(v: string): string {
  return (STATUS_LABEL as Record<string, string>)[v] ?? v;
}

// 评论/活动作者首字母（avatar 圆标）
function initialOf(name: string): string {
  return (name || '?').trim().charAt(0).toUpperCase() || '?';
}

type TabKey = 'detail' | 'comments' | 'activity';

export default function TaskDetailPanel({
  taskId,
  closing,
  onClose,
}: {
  taskId: string;
  closing?: boolean; // 退出动画态（App.closeDetail 两段式：120ms fb-panel-out 后卸载）
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [labelMenuOpen, setLabelMenuOpen] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [commentBusy, setCommentBusy] = useState(false);
  // 详情三 Tab（详情/评论/活动）：切换任务回到默认 Tab；发送评论自动跳评论页
  const [tab, setTab] = useState<TabKey>('detail');
  // 「更多」下拉（优先级/截止日期编辑收在此处，对齐原型头部极简）
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  // 状态 Select 弹层（shadcn Select：trigger + Popover 勾选菜单）
  const [statusOpen, setStatusOpen] = useState(false);
  const statusRef = useRef<HTMLDivElement>(null);

  // 面板外点关闭「更多」/「状态」菜单
  useEffect(() => {
    if (!moreOpen && !statusOpen) return;
    const onDown = (e: MouseEvent) => {
      if (moreOpen && !moreRef.current?.contains(e.target as Node)) setMoreOpen(false);
      if (statusOpen && !statusRef.current?.contains(e.target as Node)) setStatusOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [moreOpen, statusOpen]);
  // ⚠ 所有 hooks 必须在下方 if (!detail) 早退之前（React hooks 顺序规则）
  const projects = useBoardStore((s) => s.projects);
  const commentRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);

  // 打开/切换任务时拉详情
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await invoke<IssueDetail>('issue_detail', { id: taskId });
        if (!cancelled) setDetail(d);
      } catch (e) {
        console.error('issue_detail failed', e);
        showToast(errMsg(e, '加载详情失败'), true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  // 切换任务时回到默认 Tab
  useEffect(() => {
    setTab('detail');
  }, [taskId]);

  // Esc 关闭（输入框聚焦时也生效；但标题/描述编辑中先退出编辑态不关面板）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const tag = (e.target as HTMLElement)?.tagName;
      const editing = editingTitle || editingDesc;
      if ((tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') && editing) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, editingTitle, editingDesc]);

  // 更新属性（update_task + 本地刷新）
  async function updateTask(task: Task, changes: Record<string, unknown>) {
    try {
      await invoke('update_task', { id: task.id, version: task.version, changes });
      const d = await invoke<IssueDetail>('issue_detail', { id: task.id });
      setDetail(d);
      await loadBoardData();
    } catch (e) {
      console.error('update_task failed', e);
      showToast(errMsg(e, '保存失败'), true);
    }
  }

  async function submitComment() {
    const input = commentRef.current;
    if (!input) return;
    const body = input.value.trim();
    if (!body) return;
    setCommentBusy(true);
    try {
      await invoke('add_comment', { taskId, body });
      input.value = '';
      const d = await invoke<IssueDetail>('issue_detail', { id: taskId });
      setDetail(d);
      setTab('comments');   // 发送后跳到评论页看到自己的发言落位
    } catch (e) {
      console.error('add_comment failed', e);
      showToast(errMsg(e, '发送失败'), true);
    } finally {
      setCommentBusy(false);
    }
  }

  if (!detail) {
    return <aside className={`fb-detail${closing ? ' closing' : ''}`} data-testid="detail-loading">加载中…</aside>;
  }

  const t = detail.task;
  const comments = detail.comments ?? [];
  const activities = detail.activities ?? [];
  const over = isOverdue(t.dueDate) && t.status !== 'done' && t.status !== 'canceled';
  const catalog = projects[0]?.labels ?? [];
  const taskLabels = t.labels ?? [];

  async function toggleLabel(label: string) {
    const next = taskLabels.includes(label)
      ? taskLabels.filter((l) => l !== label)
      : [...taskLabels, label];
    await updateTask(t, { labels: next });
  }

  async function createLabel() {
    const label = newLabel.trim();
    if (!label) return;
    try {
      await invoke('add_label', { projectId: t.projectId, label });
      setNewLabel('');
      await toggleLabel(label);
    } catch (e) {
      showToast(errMsg(e, '新建标签失败'), true);
    }
  }

  return (
    <aside className={`fb-detail${closing ? ' closing' : ''}`}>
      <header className="d-hd">
        <span className="d-id">{t.identifier}</span>
        <span className="sp" />
        {/* 状态 Select（shadcn 口径：trigger 带色点 + Popover 菜单勾选） */}
        <div className="d-status-wrap" ref={statusRef}>
          <button
            className={`d-status-trigger${statusOpen ? ' on' : ''}`}
            title="状态"
            aria-haspopup="listbox"
            aria-expanded={statusOpen}
            onClick={() => setStatusOpen((v) => !v)}
          >
            <span className={`col-dot st-${t.status}`} aria-hidden="true" />
            {STATUS_LABEL[t.status]}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
          </button>
          {statusOpen && (
            <div className="d-status-pop" role="listbox" data-testid="status-pop">
              {Object.entries(STATUS_LABEL).map(([s, l]) => (
                <button
                  key={s}
                  role="option"
                  aria-selected={t.status === s}
                  className={`pop-item${t.status === s ? ' on' : ''}${s === 'blocked' ? ' d-status-sep' : ''}`}
                  onClick={() => {
                    if (s !== t.status) updateTask(t, { status: s });
                    setStatusOpen(false);
                  }}
                >
                  <span className={`col-dot st-${s}`} aria-hidden="true" />
                  {l}
                  <span className="check" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="d-more-wrap" ref={moreRef}>
          <button
            className={`d-more${moreOpen ? ' on' : ''}`}
            title="更多操作"
            aria-label="更多操作"
            onClick={() => setMoreOpen((v) => !v)}
          >
            <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>
          </button>
          {moreOpen && (
            <div className="d-more-menu" data-testid="detail-more">
              <div className="fb-fgtitle">优先级</div>
              <div className="d-more-pri">
                {Object.entries(PRI_LABEL).map(([p, l]) => (
                  <button
                    key={p}
                    className={`pop-item${t.priority === p ? ' on' : ''}`}
                    onClick={() => {
                      updateTask(t, { priority: p });
                      setMoreOpen(false);
                    }}
                  >
                    {l || '无'}
                    {t.priority === p && <span className="check">✓</span>}
                  </button>
                ))}
              </div>
              <div className="fb-fgtitle">截止日期</div>
              <input
                type="date"
                className="d-more-date"
                defaultValue={shortDate(t.dueDate)}
                onChange={(e) => updateTask(t, { dueDate: e.target.value || null })}
              />
            </div>
          )}
        </div>
        <button className="d-close" title="关闭（Esc）" aria-label="关闭详情" onClick={onClose}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </header>

      <div className="d-scroll">
        {editingTitle ? (
          <input
            ref={titleRef}
            className="d-title-input"
            defaultValue={t.title}
            maxLength={240}
            autoFocus
            onBlur={() => setEditingTitle(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const v = e.currentTarget.value.trim();
                if (v && v !== t.title) updateTask(t, { title: v });
                setEditingTitle(false);
              }
              if (e.key === 'Escape') setEditingTitle(false);
            }}
          />
        ) : (
          <h2 className="d-title" title="点击编辑标题" onClick={() => setEditingTitle(true)}>{t.title}</h2>
        )}

        {/* meta 行（原型口径：icon + 文字，创建者 avatar 靠右） */}
        <div className="d-meta">
          {t.priority !== 'none' && (
            <span className="d-meta-item">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3 17 6-6 4 4 8-8" /><path d="M17 7h4v4" /></svg>
              {PRI_LABEL[t.priority]}优先级
            </span>
          )}
          {taskLabels.length > 0 && (
            <span className="d-meta-item">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20.6 13.4 12 22l-9-9V4a1 1 0 0 1 1-1h9l8.6 8.6a2 2 0 0 1 0 2.8z" /><circle cx="7.5" cy="7.5" r=".5" fill="currentColor" /></svg>
              {taskLabels.join(' · ')}
            </span>
          )}
          {t.dueDate && (
            <span className={`d-meta-item${over ? ' overdue' : ''}`}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></svg>
              {shortDate(t.dueDate)}{over ? '（逾期）' : ''}
            </span>
          )}
          <span className="d-meta-item">
            建于 {shortTime(t.createdAt)}
          </span>
          {t.creatorName && (
            <span className="d-meta-item d-meta-creator" title={`${t.creatorName} 创建`}>
              <span className={`d-avatar${t.creatorType === 'agent' ? ' agent' : ''}`} aria-hidden="true">
                {initialOf(t.creatorName)}
              </span>
            </span>
          )}
        </div>

        {/* ---- 三 Tab 导航（下划线式，sticky 顶部）：详情 / 评论 / 活动 ---- */}
        {/* 下划线是共享元素（layoutId）：切 Tab 时一根线平移到目标位置，
            而非旧线淡出新线淡入。曲线对齐 tokens --ease-out。 */}
        <div className="d-tabs" role="tablist" aria-label="详情分区">
          <button
            className={`d-tab${tab === 'detail' ? ' on' : ''}`}
            role="tab"
            aria-selected={tab === 'detail'}
            onClick={() => setTab('detail')}
          >
            详情
            {tab === 'detail' && (
              <motion.span
                layoutId="d-tab-line"
                className="d-tab-line"
                transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                aria-hidden="true"
              />
            )}
          </button>
          <button
            className={`d-tab${tab === 'comments' ? ' on' : ''}`}
            role="tab"
            aria-selected={tab === 'comments'}
            onClick={() => setTab('comments')}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z"/></svg>
            评论 <span className="n">{comments.length}</span>
            {tab === 'comments' && (
              <motion.span
                layoutId="d-tab-line"
                className="d-tab-line"
                transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                aria-hidden="true"
              />
            )}
          </button>
          <button
            className={`d-tab${tab === 'activity' ? ' on' : ''}`}
            role="tab"
            aria-selected={tab === 'activity'}
            onClick={() => setTab('activity')}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
            活动
            {tab === 'activity' && (
              <motion.span
                layoutId="d-tab-line"
                className="d-tab-line"
                transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                aria-hidden="true"
              />
            )}
          </button>
        </div>

        {tab === 'detail' && (
          <>
            <div className="d-sec">
              描述
              {editingDesc ? (
                <>
                  <button
                    className="d-sec-btn"
                    onClick={() => {
                      const v = descRef.current?.value ?? '';
                      updateTask(t, { description: v });
                      setEditingDesc(false);
                    }}
                  >保存</button>
                  <button className="d-sec-btn" onClick={() => setEditingDesc(false)}>取消</button>
                </>
              ) : (
                <button className="d-sec-btn" onClick={() => setEditingDesc(true)}>编辑</button>
              )}
            </div>
            {editingDesc ? (
              <textarea
                ref={descRef}
                className="d-desc-input"
                defaultValue={t.description ?? ''}
                rows={8}
                autoFocus
                placeholder="支持 Markdown…"
              />
            ) : t.description && t.description.trim() ? (
              <div className="d-desc"><MarkdownDocument source={t.description} /></div>
            ) : (
              <div className="d-desc d-desc-empty" onClick={() => setEditingDesc(true)}>暂无描述，点击添加…</div>
            )}

            {/* 标签小节：展示 + 编辑（库标签勾选 + 新建入库）；菜单文档流展开不裁切 */}
            <div className="d-sec">
              标签 {taskLabels.length > 0 ? taskLabels.length : ''}
              <button className="d-sec-btn" onClick={() => setLabelMenuOpen((v) => !v)}>
                {labelMenuOpen ? '收起' : '编辑'}
              </button>
            </div>
            <div className="d-labels">
              {taskLabels.map((l) => (
                <span key={l} className="label-chip">{l}</span>
              ))}
              {taskLabels.length === 0 && !labelMenuOpen && (
                <span className="d-label-none">暂无标签</span>
              )}
            </div>
            {labelMenuOpen && (
              <div className="d-label-menu" data-testid="label-menu">
                {catalog.map((l) => (
                  <button
                    key={l}
                    className={taskLabels.includes(l) ? 'on' : ''}
                    onClick={() => toggleLabel(l)}
                  >
                    {taskLabels.includes(l) ? '✓ ' : ''}{l}
                  </button>
                ))}
                <div className="d-label-new">
                  <input
                    placeholder="新标签…"
                    value={newLabel}
                    onChange={(e) => setNewLabel(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        createLabel();
                      }
                    }}
                  />
                  <button onClick={createLabel}>入库</button>
                </div>
              </div>
            )}

            <RelationsEditor
              task={t}
              relations={detail.relations ?? null}
              onRefresh={async () => {
                const d = await invoke<IssueDetail>('issue_detail', { id: taskId });
                setDetail(d);
              }}
            />
            <AttachmentList
              task={t}
              attachments={detail.attachments ?? null}
              onRefresh={async () => {
                const d = await invoke<IssueDetail>('issue_detail', { id: taskId });
                setDetail(d);
              }}
            />
          </>
        )}

        {tab === 'comments' && (
          <div className="d-comments">
            {comments.map((c) => (
              <div key={c.id} className={`d-c${c.authorType === 'agent' ? ' agent' : ''}`}>
                <span className="d-avatar" aria-hidden="true">{initialOf(c.authorName)}</span>
                <div className="bub">
                  <div className="h">
                    <span className="a">{c.authorName}</span>
                    {c.authorType === 'agent' && <span className="ag">AG</span>}
                    <span className="tm">{shortTime(c.createdAt)}</span>
                  </div>
                  <div className="b"><MarkdownDocument source={c.body} /></div>
                </div>
              </div>
            ))}
            {comments.length === 0 && <div className="d-cempty">还没有评论</div>}
          </div>
        )}

        {tab === 'activity' && (
          <div className="d-acts">
            {activities.length === 0 && <div className="d-cempty">暂无活动</div>}
            {activities.slice(-20).reverse().map((a, i) => {
              const changes = activityChanges(a.changes);
              const isStatus = changes.some((c) => c.field === '状态');
              return (
                <div key={i} className="d-act">
                  <span className="dot" aria-hidden="true">
                    {isStatus ? (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
                    ) : (
                      <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="2.5"/></svg>
                    )}
                  </span>
                  <div className="what">
                    <div>
                      <span className="who">{a.actorName}</span>{' '}
                      <span className="when">{shortTime(a.createdAt)}</span>
                    </div>
                    {changes.length === 0 && <div className="diff">更新了任务</div>}
                    {changes.map((c, j) => (
                      <div key={j} className="diff">
                        <span>{c.field}</span>
                        <span className="from">{c.field === '状态' ? statusLabelOf(c.before) : c.before}</span>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
                        <span className="to">{c.field === '状态' ? statusLabelOf(c.after) : c.after}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="d-composer">
        <span className="d-avatar" aria-hidden="true">我</span>
        <div className="d-composer-box">
          <input
            ref={commentRef}
            maxLength={2000}
            placeholder="添加评论…（Enter 发送）"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submitComment();
              }
            }}
          />
        </div>
        <button className="primary d-send" disabled={commentBusy} title="发送" onClick={submitComment}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m22 2-7 20-4-9-9-4z" /><path d="M22 2 11 13" /></svg>
        </button>
      </div>
    </aside>
  );
}

// projectId 在 Task 类型上（projectId?: string；fullboard 单项目 local）

