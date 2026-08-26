/* ============================================================
 * 任务详情覆盖层（L3-本机：详情+评论）—— 移植自 detail.js
 * 覆盖式视图：绝对定位叠在 large 之上，不改窗口尺寸。
 * 契约：#detail #dBack #dIdent #dStatus #dTitle #dAct #dMeta #dDesc
 * #dSec #dComments #dCEmpty #dcInput #dcSend；评论输入非受控（e2e 契约）。
 * v0.3.2 M3 就地编辑：#dPri（优先级 chip）→ #dPriMenu（5 项 data-p）；
 * #dDue（截止 chip）→ #dDueInput（原生 date，空值=清除）+ #dDueClear。
 * ============================================================ */
import { useEffect, useRef, useState } from 'react';
import { addComment, moveTask, refreshDetail, updateTask } from '../lib/api';
import { boardActions } from '../lib/actions';
import { errMsg, showToast } from '../lib/toast';
import { isOverdue, priLabel, shortDate, shortTime } from '../lib/format';
import { useAppStore } from '../store/useAppStore';
import { STATUS_LABEL } from '../lib/types';

// 优先级菜单项（顺序=菜单展示序；'none' = 清除，与 SQLite CHECK 枚举一致）
const PRI_OPTIONS: { v: string; label: string }[] = [
  { v: 'urgent', label: '紧急' },
  { v: 'high', label: '高' },
  { v: 'medium', label: '中' },
  { v: 'low', label: '低' },
  { v: 'none', label: '无' },
];

export default function TaskDetail() {
  const detail = useAppStore((s) => s.detail);
  const detailId = useAppStore((s) => s.detailId);
  const closeDetail = useAppStore((s) => s.closeDetail);
  const inputRef = useRef<HTMLInputElement>(null);
  const sendRef = useRef<HTMLButtonElement>(null);
  // 就地编辑态（v0.3.2）：标题/描述点击进入，非受控（defaultValue + ref
  // 读值，e2e 直接设 value 不派发事件——与 NewTaskPanel 同一硬契约）
  const [editing, setEditing] = useState<'title' | 'desc' | null>(null);
  const titleEditRef = useRef<HTMLInputElement>(null);
  const descEditRef = useRef<HTMLTextAreaElement>(null);
  // M3：优先级菜单 / 截止日编辑态（互斥展开，meta 行内就地切换）
  const [priMenu, setPriMenu] = useState(false);
  const [dueEdit, setDueEdit] = useState(false);

  // 点菜单外任意处收起优先级菜单（chip 自身点击走 toggle，不经过这里关闭）
  useEffect(() => {
    if (!priMenu) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest?.('.d-pri-wrap')) setPriMenu(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [priMenu]);

  // 挂载或目标任务变化即拉取（等价旧 openDetail → refreshDetail；错误
  // 处理在 api 内 toast）。detailId 依赖：通知路由可 detail→detail 直切
  // （不经过 closeDetail 卸载重挂载），不订阅会停留在上一个任务。
  useEffect(() => {
    // 切换目标任务时收起就地编辑（组件常驻不卸载，state 需手动复位）
    setPriMenu(false);
    setDueEdit(false);
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

  // 元信息行：优先级（可编辑）/ 截止（可编辑）/ 创建者 / 会话归属 / 创建时间
  const meta: React.ReactNode[] = [];
  const openPri = () => { setPriMenu((v) => !v); setDueEdit(false); };
  const priMenuNode = priMenu ? (
    <div className="d-pri-menu" id="dPriMenu" role="menu"
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setPriMenu(false); } }}>
      {PRI_OPTIONS.map((o) => (
        <button key={o.v} data-p={o.v} role="menuitem"
          className={t.priority === o.v ? 'on' : undefined}
          onClick={() => {
            setPriMenu(false);
            if (t.priority !== o.v) saveField({ priority: o.v });
          }}>
          {o.label}{t.priority === o.v ? ' ✓' : ''}
        </button>
      ))}
    </div>
  ) : null;
  if (t.priority && t.priority !== 'none') {
    meta.push(
      <span key="pri" className="d-pri-wrap">
        <span id="dPri" role="button" tabIndex={0} className="d-meta-edit" onClick={openPri}>
          {priLabel(t.priority)}优先级
        </span>
        {priMenuNode}
      </span>,
    );
  } else {
    meta.push(
      <span key="pri" className="d-pri-wrap">
        <span id="dPri" role="button" tabIndex={0} className="d-meta-add" onClick={openPri}>
          + 优先级
        </span>
        {priMenuNode}
      </span>,
    );
  }
  if (dueEdit) {
    // 截止日编辑态：原生 date（UA 日历随 color-scheme 适配主题）；选空/清空 = 清除
    meta.push(
      <span key="due" className="d-due-edit">
        <input
          id="dDueInput"
          type="date"
          defaultValue={t.dueDate ? shortDate(t.dueDate) : ''}
          autoFocus
          onChange={(e) => {
            const v = e.currentTarget.value;
            setDueEdit(false);
            if (v && v !== shortDate(t.dueDate ?? '')) saveField({ dueDate: v });
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.stopPropagation(); setDueEdit(false); }
          }}
        />
        {t.dueDate && (
          <button id="dDueClear" title="清除截止日"
            onClick={() => { setDueEdit(false); saveField({ dueDate: null }); }}>
            ×
          </button>
        )}
      </span>,
    );
  } else if (t.dueDate) {
    const over = isOverdue(t.dueDate) && t.status !== 'done' && t.status !== 'canceled';
    meta.push(
      <span key="due" id="dDue" role="button" tabIndex={0}
        className={`d-meta-edit${over ? ' overdue' : ''}`}
        onClick={() => { setDueEdit(true); setPriMenu(false); }}>
        截止 {shortDate(t.dueDate)}{over ? '（逾期）' : ''}
      </span>,
    );
  } else {
    meta.push(
      <span key="due" id="dDue" role="button" tabIndex={0} className="d-meta-add"
        onClick={() => { setDueEdit(true); setPriMenu(false); }}>
        + 截止日
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

  // 就地保存（updateTask 含冲突重试；二次仍冲突保留编辑态不清空输入）
  async function saveEdit(field: 'title' | 'desc', value: string) {
    const task = useAppStore.getState().detail?.task;
    if (!task) { setEditing(null); return; }
    const v = value.trim();
    const key = field === 'title' ? 'title' : 'description'; // 编辑态名 → API 字段名
    const original = field === 'title' ? task.title : (task.description ?? '');
    if (!v || v === original) { setEditing(null); return; }
    try {
      await updateTask(task, { [key]: v });
      setEditing(null);
      await refreshDetail();
    } catch (err) {
      console.error('update failed', err);
      showToast(errMsg(err, '保存失败'), true);
      // 保持编辑态：输入内容不丢，用户可改后重试或 Esc 放弃
    }
  }

  // M3 字段编辑（优先级/截止日）：chip 点击即改，无编辑态可回退——
  // 同一 updateTask 协议（乐观并发+冲突重试），失败 toast 不静默
  async function saveField(changes: Record<string, unknown>) {
    const task = useAppStore.getState().detail?.task;
    if (!task) return;
    try {
      await updateTask(task, changes);
      await refreshDetail();
    } catch (err) {
      console.error('update failed', err);
      showToast(errMsg(err, '保存失败'), true);
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
        {editing === 'title' ? (
          <input
            id="dTitleInput"
            ref={titleEditRef}
            className="d-title-input"
            defaultValue={t.title}
            maxLength={240}
            autoFocus
            onBlur={() => setEditing(null)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                saveEdit('title', e.currentTarget.value);
              }
              if (e.key === 'Escape') {
                e.stopPropagation(); // 先退出编辑，不冒泡给 App 级 Esc（会关详情）
                setEditing(null);
              }
            }}
          />
        ) : (
          <div className="d-title" id="dTitle" title="点击编辑标题" onClick={() => setEditing('title')}>
            {t.title}
          </div>
        )}
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
        {editing === 'desc' ? (
          <textarea
            id="dDescEdit"
            ref={descEditRef}
            className="d-desc-edit"
            defaultValue={t.description ?? ''}
            maxLength={4000}
            rows={3}
            autoFocus
            onBlur={() => setEditing(null)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                saveEdit('desc', e.currentTarget.value);
              }
              if (e.key === 'Escape') {
                e.stopPropagation(); // 先退出编辑，不冒泡给 App 级 Esc（会关详情）
                setEditing(null);
              }
            }}
          />
        ) : t.description && t.description.trim() ? (
          <div className="d-desc" id="dDesc" title="点击编辑描述" onClick={() => setEditing('desc')}>
            {t.description}
          </div>
        ) : (
          <div className="d-desc d-desc-add" id="dDesc" role="button" tabIndex={0} onClick={() => setEditing('desc')}>
            + 补充描述
          </div>
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
