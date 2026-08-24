/* ============================================================
 * render-board —— 看板列视图渲染（依赖 config + state）
 *
 * 6 状态列横排（对齐 STATUS_ORDER，canceled 不入板——与 mini 轮播口径一致）；
 * 卡片：形状点 + 标题（两行截断）+ 优先级/逾期；hover 快捷流转（复用 moveTask）；
 * 点卡片进详情（detail 覆盖层，返回回到看板）。
 * ============================================================ */

// 状态 → 下一步动作按钮（与列表 act 同一套流转协议，窄卡文案精简）
function boardActions(t){
  switch (t.status){
    case 'todo':        return [{ s:'in_progress', label:'认领', primary:true }];
    case 'in_progress': return [{ s:'in_review', label:'推进' }, { s:'done', label:'完成', primary:true }];
    case 'in_review':   return [{ s:'done', label:'接受', primary:true }, { s:'in_progress', label:'退回' }];
    case 'blocked':     return [{ s:'todo', label:'解除' }];
    default:            return [];      // backlog / done 无快捷流转
  }
}

function renderBoard(){
  const board = byId('board');
  if (state.largeView !== 'board'){ board.style.display = 'none'; return; }
  board.style.display = 'flex';

  // 列表/空态/计数条在 board 布局下隐藏（列头自带计数）
  byId('list').style.display = 'none';
  byId('empty').style.display = 'none';
  byId('counts').style.display = 'none';
  // 离线态与列表视图共用同一条 offline 提示
  byId('offline').style.display = state.online ? 'none' : 'flex';

  if (!state.online){ board.innerHTML = ''; return; }

  const byStatus = {};
  STATUS_ORDER.forEach((s) => { byStatus[s] = []; });
  state.tasks.forEach((t) => {
    if (t.status === 'canceled') return;
    (byStatus[t.status] || byStatus.backlog).push(t);
  });

  board.innerHTML = STATUS_ORDER.map((s) => {
    const tasks = byStatus[s];
    const cards = tasks.map((t) => {
      const badge = priBadge(t.priority);
      const pri = badge ? `<div class="pri ${badge}">${PRI_LABEL[badge]}</div>` : '';
      const due = shortDate(t.dueDate);
      const over = isOverdue(t.dueDate) && t.status !== 'done';
      const dueHtml = due ? `<span${over ? ' class="overdue"' : ''}>${due}</span>` : '';
      const acts = boardActions(t).map((a) =>
        `<button data-a="${a.s}"${a.primary ? ' class="primary"' : ''}>${a.label}</button>`
      ).join('');
      return `<div class="bcard${t.status === 'done' ? ' dim' : ''}" data-id="${t.id}">
        <div class="row1"><div class="shape ${shapeClass(t.status)}"></div>${pri}${dueHtml ? `<div class="due">${dueHtml}</div>` : ''}</div>
        <div class="t">${t.title}</div>
        <div class="m">${t.identifier}</div>
        ${acts ? `<div class="act">${acts}</div>` : ''}
      </div>`;
    }).join('');
    const emptyCol = tasks.length ? '' : `<div class="bempty">空</div>`;
    return `<div class="bcol" data-s="${s}">
      <div class="bhead"><span class="n">${STATUS_LABEL[s]}</span><span class="c">${tasks.length}</span></div>
      <div class="bstack">${cards}${emptyCol}</div>
    </div>`;
  }).join('');
}

// 数据变化时自动重绘（与 renderLarge 同一订阅源）
subscribe(renderBoard);
