/* ============================================================
 * detail —— 任务详情视图（L3-本机：详情 + 评论，依赖 config + state + api）
 *
 * 覆盖式视图：绝对定位叠在 large 之上，不改列表区的 display 状态；
 * 列表 ↔ 详情切换只动 .detail 自己 + state.largeView。
 * 数据流：openDetail 拉取 → renderDetail 渲染；
 *         刷新来源 = 发表评论（task.comment 事件）+ 轮询兜底（api.js tick）。
 * ============================================================ */

// 进入详情：拉数据 → 显示覆盖层（列表/看板渲染在 detail 模式下跳过）
async function openDetail(task){
  if (byId('newPanel').style.display === 'flex'){ toggleNewPanel(false); }
  state.detailFrom = state.largeView;      // 记录来源布局（list / board）
  state.detailId = task.id;
  state.largeView = 'detail';
  byId('detail').style.display = 'flex';
  await refreshDetail();
}

// 返回来源视图（列表或看板）
function closeDetail(){
  const back = state.detailFrom === 'board' ? 'board' : 'list';
  state.largeView = back;
  state.detailId = null;
  state.detail = null;
  byId('detail').style.display = 'none';
  if (back === 'board'){ renderBoard(); } else { renderLarge(); }
}

// 拉取并渲染（任务被外部删除时退回列表；其他错误 toast 提示而非静默吞掉）
async function refreshDetail(){
  if (!state.detailId) return;
  try{
    state.detail = await issueDetail(state.detailId);
    renderDetail();
  }catch(e){
    if (e && e.code === 'TASK_NOT_FOUND'){ closeDetail(); return; }
    console.error('issue_detail failed', e);
    showToast((e && (e.message || e)) || '加载详情失败', true);
  }
}

// 渲染详情（body 均经 esc 转义，来自数据库的内容不可直接 innerHTML）
function renderDetail(){
  const d = state.detail;
  if (!d) return;
  const t = d.task;

  byId('dIdent').textContent = t.identifier;
  const st = byId('dStatus');
  st.textContent = STATUS_LABEL[t.status] || t.status;
  st.className = 'd-st ' + t.status;

  byId('dTitle').textContent = t.title;

  // 元信息行：优先级 / 截止 / 创建者 / 会话归属（人机协议可见性）/ 创建时间
  const meta = [];
  if (t.priority && t.priority !== 'none'){ meta.push(`<span>${PRI_LABEL[t.priority] || t.priority}优先级</span>`); }
  if (t.dueDate){
    const over = isOverdue(t.dueDate) && t.status !== 'done' && t.status !== 'canceled';
    meta.push(`<span${over ? ' class="overdue"' : ''}>截止 ${shortDate(t.dueDate)}${over ? '（逾期）' : ''}</span>`);
  }
  const creator = t.creatorType === 'agent'
    ? `<span class="agent">${esc(t.creatorName)} 创建</span>`
    : (t.creatorName && t.creatorName !== '本地用户' ? `<span>${esc(t.creatorName)} 创建</span>` : '');
  if (creator){ meta.push(creator); }
  if (t.threadId){ meta.push(`<span>会话 ${esc(t.threadId)}</span>`); }
  meta.push(`<span>建于 ${shortTime(t.createdAt)}</span>`);
  byId('dMeta').innerHTML = meta.join('');

  const desc = byId('dDesc');
  if (t.description && t.description.trim()){
    desc.style.display = 'block';
    desc.textContent = t.description;
  } else {
    desc.style.display = 'none';
  }

  // 评论列表：agent 发言以强调色标注作者（AI 是第一等用户，人机一眼可分）
  const comments = d.comments || [];
  byId('dSec').textContent = `评论 ${comments.length}`;
  byId('dCEmpty').style.display = comments.length ? 'none' : 'block';
  byId('dComments').innerHTML = comments.map((c) => {
    const agent = c.authorType === 'agent' ? ' agent' : '';
    return `<div class="d-c${agent}">
      <div class="h"><span class="a">${esc(c.authorName)}</span><span class="tm">${shortTime(c.createdAt)}</span></div>
      <div class="b">${esc(c.body)}</div>
    </div>`;
  }).join('');
}

// 发表评论：提交 → 事件驱动刷新（refreshDetail 兜底）
async function submitComment(){
  const input = byId('dcInput');
  const body = input.value.trim();
  if (!body || !state.detailId) return;
  const btn = byId('dcSend');
  btn.disabled = true;
  try{
    await addComment(state.detailId, body);
    input.value = '';
    await refreshDetail();
  }catch(e){
    console.error('add_comment failed', e);
    showToast((e && (e.message || e)) || '发送失败', true);
  }finally{
    btn.disabled = false;
  }
}

// 详情内事件绑定（脚本在 body 末尾，DOM 已就绪）
byId('dBack').addEventListener('click', closeDetail);
byId('dcSend').addEventListener('click', submitComment);
byId('dcInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter'){ e.preventDefault(); submitComment(); }
});
