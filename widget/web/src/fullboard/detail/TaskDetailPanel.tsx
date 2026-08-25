/* ============================================================
 * 任务详情面板 —— 右侧抽屉（对齐 upstream TaskDetail 的核心交互）
 * · 标题/优先级/状态/日期 inline 编辑（update_task）
 * · 描述 Markdown 预览 / 编辑切换
 * · 评论列表 + 发表（add_comment；Enter 发送）
 * · 活动流（issue_detail 的 activities，changes diff 渲染）
 * 数据刷新：写操作后本地 issue_detail 重拉 + Rust 事件兜底。
 * ============================================================ */
import { useEffect, useRef, useState } from 'react';
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

// 活动流 changes → 文案
function activityText(changesJson: string): string {
  try {
    const changes = JSON.parse(changesJson);
    if (!Array.isArray(changes)) return '';
    return changes
      .map((c: { field: string; before: unknown; after: unknown }) => {
        const f = FIELD_LABEL[c.field] ?? c.field;
        const b = Array.isArray(c.before) ? c.before.join(',') : String(c.before ?? '—');
        const a = Array.isArray(c.after) ? c.after.join(',') : String(c.after ?? '—');
        return `${f}：${b} → ${a}`;
      })
      .join('；');
  } catch {
    return '';
  }
}

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
        <button className="d-back" title="返回看板（Esc）" onClick={onClose}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
        </button>
        <span className="d-id">{t.identifier}</span>
        <select
          className="d-status"
          value={t.status}
          onChange={(e) => updateTask(t, { status: e.target.value })}
          title="状态"
        >
          {Object.entries(STATUS_LABEL).map(([s, l]) => (
            <option key={s} value={s}>{l}</option>
          ))}
        </select>
        <select
          className="d-pri"
          value={t.priority}
          onChange={(e) => updateTask(t, { priority: e.target.value })}
          title="优先级"
        >
          {Object.entries(PRI_LABEL).map(([p, l]) => (
            <option key={p} value={p}>{l || '无'}</option>
          ))}
        </select>
        <input
          type="date"
          className="d-date"
          defaultValue={shortDate(t.dueDate)}
          title="截止日期"
          onChange={(e) => updateTask(t, { dueDate: e.target.value || null })}
        />
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

        <div className="d-meta">
          {t.priority !== 'none' && <span>{PRI_LABEL[t.priority]}优先级</span>}
          {t.dueDate && (
            <span className={over ? 'overdue' : undefined}>
              截止 {shortDate(t.dueDate)}{over ? '（逾期）' : ''}
            </span>
          )}
          {t.creatorType === 'agent' ? (
            <span className="agent">{t.creatorName || 'AI'} 创建</span>
          ) : (
            t.creatorName && t.creatorName !== '本地用户' && <span>{t.creatorName} 创建</span>
          )}
          <span>建于 {shortTime(t.createdAt)}</span>
        </div>

        {/* 标签行：展示 + 点击编辑（库标签勾选 + 新建入库） */}
        <div className="d-labels">
          {taskLabels.map((l) => (
            <span key={l} className="label-chip">{l}</span>
          ))}
          <button className="d-label-add" onClick={() => setLabelMenuOpen((v) => !v)}>
            {taskLabels.length === 0 ? '+ 标签' : '+'}
          </button>
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
        <div className="d-sec">评论 {comments.length}</div>
        <div className="d-comments">
          {comments.map((c) => (
            <div key={c.id} className={`d-c${c.authorType === 'agent' ? ' agent' : ''}`}>
              <div className="h">
                <span className="a">{c.authorName}</span>
                <span className="tm">{shortTime(c.createdAt)}</span>
              </div>
              <div className="b"><MarkdownDocument source={c.body} /></div>
            </div>
          ))}
          {comments.length === 0 && <div className="d-cempty">还没有评论</div>}
        </div>

        {activities.length > 0 && (
          <>
            <div className="d-sec">活动</div>
            <div className="d-acts">
              {activities.slice(-20).reverse().map((a, i) => (
                <div key={i} className="d-act">
                  <span className="who">{a.actorName}</span>
                  <span className="what">{activityText(a.changes)}</span>
                  <span className="when">{shortTime(a.createdAt)}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="d-composer">
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
        <button className="primary" disabled={commentBusy} onClick={submitComment}>发送</button>
      </div>
    </aside>
  );
}

// projectId 在 Task 类型上（projectId?: string；fullboard 单项目 local）

