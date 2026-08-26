/* ============================================================
 * 任务详情覆盖层（L3-本机：详情+评论）—— 移植自 detail.js
 * 覆盖式视图：绝对定位叠在 large 之上，不改窗口尺寸。
 * 契约：#detail #dBack #dIdent #dStatus #dTitle #dAct #dMeta #dDesc
 * #dSec #dComments #dCEmpty #dcInput #dcSend；评论输入非受控（e2e 契约）。
 * ============================================================ */
import { useEffect, useRef } from 'react';
import { addComment, moveTask, refreshDetail } from '../lib/api';
import { boardActions } from '../lib/actions';
import { errMsg, showToast } from '../lib/toast';
import { isOverdue, priLabel, shortDate, shortTime } from '../lib/format';
import { useAppStore } from '../store/useAppStore';
import { STATUS_LABEL } from '../lib/types';

export default function TaskDetail() {
  const detail = useAppStore((s) => s.detail);
  const detailId = useAppStore((s) => s.detailId);
  const closeDetail = useAppStore((s) => s.closeDetail);
  const inputRef = useRef<HTMLInputElement>(null);
  const sendRef = useRef<HTMLButtonElement>(null);

  // 挂载或目标任务变化即拉取（等价旧 openDetail → refreshDetail；错误
  // 处理在 api 内 toast）。detailId 依赖：通知路由可 detail→detail 直切
  // （不经过 closeDetail 卸载重挂载），不订阅会停留在上一个任务。
  useEffect(() => {
    if (detailId) refreshDetail().catch((e) => console.error('open detail failed', e));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 普通路径挂载时 detailId 已是新值，语义一致
  }, [detailId]);

  if (!detail) {
    return (
      <div className="detail" id="detail" style={{ display: 'flex' }} />
    );
  }

  const t = detail.task;
  const comments = detail.comments || [];
  const acts = boardActions(t);

  // 元信息行：优先级 / 截止 / 创建者 / 会话归属 / 创建时间
  const meta: React.ReactNode[] = [];
  if (t.priority && t.priority !== 'none') {
    meta.push(<span key="pri">{priLabel(t.priority)}优先级</span>);
  }
  if (t.dueDate) {
    const over = isOverdue(t.dueDate) && t.status !== 'done' && t.status !== 'canceled';
    meta.push(
      <span key="due" className={over ? 'overdue' : undefined}>
        截止 {shortDate(t.dueDate)}{over ? '（逾期）' : ''}
      </span>,
    );
  }
  if (t.creatorType === 'agent') {
    meta.push(<span key="creator" className="agent">{t.creatorName} 创建</span>);
  } else if (t.creatorName && t.creatorName !== '本地用户') {
    meta.push(<span key="creator">{t.creatorName} 创建</span>);
  }
  if (t.threadId) {
    meta.push(<span key="thread">会话 {t.threadId}</span>);
  }
  meta.push(<span key="created">建于 {shortTime(t.createdAt)}</span>);

  // 发表评论：提交 → 事件驱动刷新（refreshDetail 兜底）
  async function submitComment() {
    const input = inputRef.current;
    if (!input) return;
    const body = input.value.trim();
    if (!body) return;
    const btn = sendRef.current;
    if (btn) btn.disabled = true;
    try {
      await addComment(useAppStore.getState().detailId!, body);
      input.value = '';
      await refreshDetail();
    } catch (e) {
      console.error('add_comment failed', e);
      showToast(errMsg(e, '发送失败'), true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // 流转：与列表/看板同一协议（moveTask 含冲突重试；失败 toast 不静默）
  async function onMove(status: string, btn: HTMLButtonElement) {
    const task = useAppStore.getState().detail?.task;
    if (!task) return;
    btn.disabled = true;
    try {
      await moveTask(task, status);
      await refreshDetail(); // 状态徽章与动作条即时更新
    } catch (err) {
      console.error('move failed', err);
      showToast(errMsg(err, '流转失败'), true);
    } finally {
      btn.disabled = false;
    }
  }

  return (
    <div className="detail" id="detail" style={{ display: 'flex' }}>
      <div className="d-hd">
        <div
          className="ic"
          id="dBack"
          title="返回列表"
          role="button"
          tabIndex={0}
          onClick={closeDetail}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
        </div>
        <div className="d-id" id="dIdent">{t.identifier}</div>
        <div className="sp" />
        <div className={`d-st ${t.status}`} id="dStatus">
          {STATUS_LABEL[t.status] || t.status}
        </div>
      </div>
      <div className="d-scroll">
        <div className="d-title" id="dTitle">{t.title}</div>
        <div className="d-act" id="dAct">
          {acts.map((a) => (
            <button
              key={a.s}
              className={a.primary ? 'primary' : undefined}
              data-a={a.s}
              onClick={(e) => onMove(a.s, e.currentTarget)}
            >
              {a.label}
            </button>
          ))}
        </div>
        <div className="d-meta" id="dMeta">{meta}</div>
        {t.description && t.description.trim() ? (
          <div className="d-desc" id="dDesc" style={{ display: 'block' }}>{t.description}</div>
        ) : (
          <div className="d-desc" id="dDesc" style={{ display: 'none' }} />
        )}
        <div className="d-sec" id="dSec">评论 {comments.length}</div>
        <div className="d-comments" id="dComments">
          {comments.map((c) => (
            <div key={c.id} className={`d-c${c.authorType === 'agent' ? ' agent' : ''}`}>
              <div className="h">
                <span className="a">{c.authorName}</span>
                <span className="tm">{shortTime(c.createdAt)}</span>
              </div>
              <div className="b">{c.body}</div>
            </div>
          ))}
        </div>
        <div className="d-cempty" id="dCEmpty" style={{ display: comments.length ? 'none' : 'block' }}>
          还没有评论
        </div>
      </div>
      <div className="d-composer">
        <input
          id="dcInput"
          ref={inputRef}
          maxLength={2000}
          placeholder="添加评论…（Enter 发送）"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submitComment();
            }
          }}
        />
        <button className="primary" id="dcSend" ref={sendRef} onClick={submitComment}>
          发送
        </button>
      </div>
    </div>
  );
}
