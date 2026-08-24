/* ============================================================
 * render-large —— 大挂件渲染（依赖 config + state）
 * ============================================================ */

function countsMap(){
  const m = {};
  state.tasks.forEach((t) => { m[t.status] = (m[t.status] || 0) + 1; });
  return m;
}

function renderLarge(){
  // 详情/看板视图时跳过列表重绘（覆盖层或 board 容器已接管；返回列表时会主动调用恢复）
  if (state.largeView === 'detail' || state.largeView === 'board') return;
  // 项目名
  const proj = state.projects.find((p) => p.id === 'local') || state.projects[0];
  byId('projName').textContent = proj?.name || '—';

  // 状态计数条（首格「全部」——筛选的唯一复位入口，没有它点入状态后回不到全量列表）
  const map = countsMap();
  const allCell = `<div class="c${state.filter === 'all' ? ' on' : ''}" data-s="all" role="button" tabindex="0"><div class="n">${state.tasks.length}</div><div class="l">全部</div></div>`;
  byId('counts').innerHTML = allCell + STATUS_ORDER.map((s) => {
    const n = map[s] || 0;
    const danger = s === 'blocked' ? ' danger' : '';
    const on = state.filter === s ? ' on' : '';
    return `<div class="c${danger}${on}" data-s="${s}" role="button" tabindex="0"><div class="n">${n}</div><div class="l">${STATUS_LABEL[s]}</div></div>`;
  }).join('');

  // 离线态
  byId('offline').style.display = state.online ? 'none' : 'flex';

  // 列表
  const rows = state.tasks.filter((t) => state.filter === 'all' || t.status === state.filter);
  const list = byId('list');
  const empty = byId('empty');
  if (!state.online){ list.innerHTML = ''; empty.style.display = 'none'; return; }
  if (!rows.length){
    list.innerHTML = '';
    empty.style.display = 'flex';
    // 区分「全库为空的首启」与「该筛选下无任务」
    if (state.tasks.length === 0){
      byId('emptyT').textContent = '还没有任务';
      byId('emptyS').textContent = '点击这里创建第一个任务';
      empty.classList.add('actionable');
    } else {
      byId('emptyT').textContent = '这个状态下还没有任务';
      byId('emptyS').textContent = '试试上方的状态计数切换筛选';
      empty.classList.remove('actionable');
    }
    return;
  }
  empty.style.display = 'none';

  list.innerHTML = rows.map((t) => {
    const dim = (t.status === 'done' || t.status === 'canceled') ? ' dim' : '';
    const badge = priBadge(t.priority);
    const pri = badge ? `<div class="pri ${badge}">${PRI_LABEL[badge]}</div>` : '';
    const act = boardActions(t).map((a) =>
      `<button${a.primary ? ' class="primary"' : ''} data-a="${a.s}">${a.label}</button>`
    ).join('');
    const due = shortDate(t.dueDate);
    const dueHtml = due ? ` · <span${isOverdue(t.dueDate) ? ' class="overdue"' : ''}>${due}</span>` : '';
    const agent = t.creatorType === 'agent' ? '<span class="ag" title="AI 会话创建">AI</span>' : '';
    return `<div class="item${dim}" data-id="${t.id}" role="button" tabindex="0">
      <div class="shape ${shapeClass(t.status)}"></div>
      <div class="mid"><div class="t">${esc(t.title)}</div><div class="m">${agent}${esc(t.identifier)}${dueHtml}</div></div>
      ${pri}
      <div class="act">${act}</div>
    </div>`;
  }).join('');
}

// 数据变化时自动重绘
subscribe(renderLarge);
