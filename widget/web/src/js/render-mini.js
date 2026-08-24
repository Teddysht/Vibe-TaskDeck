/* ============================================================
 * render-mini —— 最小胶囊渲染 + 轮转（依赖 config + state）
 * ============================================================ */

function renderMini(){
  const shape = byId('miniShape');
  const title = byId('miniT');
  const meta = byId('miniMeta');
  const pri = byId('miniPri');
  const dots = byId('miniDots');

  if (!state.online){
    shape.className = 'shape idle';
    title.textContent = '数据层不可用';
    meta.textContent = '正在重试…';
    meta.classList.remove('overdue');
    pri.style.display = 'none';
    dots.innerHTML = '';
    return;
  }
  if (!state.seq.length){
    shape.className = 'shape idle';
    if (state.tasks.length){
      title.textContent = '任务都处理完了';
      meta.textContent = '当前没有需要关注的任务';
    } else {
      title.textContent = '还没有任务';
      meta.textContent = '展开后点击「新建任务」创建';
    }
    meta.classList.remove('overdue');
    pri.style.display = 'none';
    dots.innerHTML = '';
    return;
  }

  const item = state.seq[state.idx];
  shape.className = 'shape ' + shapeClass(item.status);
  title.textContent = item.title;
  const due = shortDate(item.dueDate);
  meta.textContent = item.identifier + ' · ' + STATUS_LABEL[item.status] + (due ? ' · ' + due : '');
  meta.classList.toggle('overdue', isOverdue(item.dueDate));

  // 轮转切换到不同任务时给一次轻过渡（同一任务的数据刷新不打扰）
  const body = byId('miniBody');
  if (item.id !== _lastShownId){
    body.classList.remove('swap');
    void body.offsetWidth;   // 强制 reflow 以重启动画
    body.classList.add('swap');
    _lastShownId = item.id;
  }

  const badge = priBadge(item.priority);
  if (badge){
    pri.style.display = '';
    pri.textContent = PRI_LABEL[badge];
    pri.className = 'pri ' + (badge === 'urgent' ? 'urgent' : 'high');
  } else {
    pri.style.display = 'none';
  }

  dots.innerHTML = state.seq.map((_, i) => `<i class="${i === state.idx ? 'on' : ''}" data-i="${i}"></i>`).join('');
}

let _lastShownId = null;

// 轮转定时器（大挂件展开时暂停）
let _rotTimer = null;
function startRotate(){
  if (_rotTimer) return;
  _rotTimer = setInterval(() => {
    if (!state.seq.length) return;
    state.idx = (state.idx + 1) % state.seq.length;
    renderMini();
  }, ROTATE_MS);
}
function stopRotate(){
  if (_rotTimer){ clearInterval(_rotTimer); _rotTimer = null; }
}

// 数据变化时自动重绘
subscribe(renderMini);
