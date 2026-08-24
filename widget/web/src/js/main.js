/* ============================================================
 * main —— 装配：事件绑定 + 新建任务面板 + 启动（依赖所有模块，最后加载）
 * ============================================================ */

function bindEvents(){
  // mini → large
  byId('expandBtn').addEventListener('click', (e) => { e.stopPropagation(); switchView('large'); });
  // large → mini
  byId('collapseBtn').addEventListener('click', () => switchView('mini'));
  // 退出
  byId('closeBtn').addEventListener('click', closeWidget);
  // 全版看板（L3-全版：起 server + 第二窗口；加载中转圈，失败弹 toast 降级提示）
  byId('boardBtn').addEventListener('click', async () => {
    const btn = byId('boardBtn');
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('spin');
    try{
      await openFullBoard();
      showToast('全版看板已打开');
    }catch(e){
      const msg = (e && (e.message || e)) || '打开失败';
      showToast(msg.includes('node') || msg.includes('Node') ? '需要 Node.js 22.5+ 与 upstream 源码' : msg, true);
    }finally{
      btn.disabled = false;
      btn.classList.remove('spin');
    }
  });
  // 轮转指示点：跳转
  byId('miniDots').addEventListener('click', (e) => {
    const i = e.target.dataset.i;
    if (i !== undefined){ state.idx = Number(i); renderMini(); }
  });
  // 计数条：筛选
  byId('counts').addEventListener('click', (e) => {
    const c = e.target.closest('.c');
    if (!c) return;
    setFilter(c.dataset.s);
  });
  // 列表：快捷操作按钮 / 点条目进详情（L3-本机）
  byId('list').addEventListener('click', async (e) => {
    const item = e.target.closest('.item');
    if (!item) return;
    const task = state.tasks.find((t) => t.id === item.dataset.id);
    if (!task) return;
    const btn = e.target.closest('button[data-a]');
    if (btn){
      btn.disabled = true;
      try{ await moveTask(task, btn.dataset.a); }
      catch(err){ console.error('move failed', err); }
      finally{ btn.disabled = false; }
      return;
    }
    openDetail(task).catch((err) => console.error('open detail failed', err));
  });
  // Esc：详情 → 列表（详情输入框聚焦时也生效；newPanel 的 Esc 已有独立处理）
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.largeView === 'detail'){ closeDetail(); }
  });
  // 新建任务：展开/收起表单；空态区域也可直达（首启引导）
  byId('newBtn').addEventListener('click', () => toggleNewPanel());
  byId('empty').addEventListener('click', () => toggleNewPanel(true));
  byId('npSubmit').addEventListener('click', submitNewTask);
  byId('npCancel').addEventListener('click', () => toggleNewPanel(false));
  byId('npTitle').addEventListener('keydown', (e) => {
    if (e.key === 'Enter'){ e.preventDefault(); submitNewTask(); }
    if (e.key === 'Escape'){ toggleNewPanel(false); }
  });
}

// ============================================================
// 新建任务面板（折叠交互态，不进 state；renderLarge 不覆写此区域）
// ============================================================

function toggleNewPanel(open){
  const panel = byId('newPanel');
  const show = open !== undefined ? open : panel.style.display === 'none';
  panel.style.display = show ? 'flex' : 'none';
  if (show){ byId('npTitle').focus(); }
  else { resetNewPanel(); }
}

function resetNewPanel(){
  byId('npTitle').value = '';
  byId('npDue').value = '';
  byId('npStatus').value = 'backlog';
  byId('npPriority').value = 'none';
  byId('npErr').textContent = '';
}

async function submitNewTask(){
  const title = byId('npTitle').value.trim();
  if (!title){ byId('npErr').textContent = '标题必填'; return; }
  const btn = byId('npSubmit');
  btn.disabled = true;
  try{
    await createTask({
      title,
      status: byId('npStatus').value,
      priority: byId('npPriority').value,
      dueDate: byId('npDue').value || null,
    });
    toggleNewPanel(false);               // 关闭并清空
    await loadData().catch(() => {});     // 双保险（Rust 事件也会触发一次）
  }catch(e){
    byId('npErr').textContent = (e && e.message) || '创建失败';
  }finally{
    btn.disabled = false;
  }
}

// 初始化新建表单下拉选项（状态 7 项 / 优先级 5 项）
function initNewPanel(){
  byId('npStatus').innerHTML = STATUS_ORDER
    .map((s) => `<option value="${s}">${STATUS_LABEL[s]}</option>`).join('');
  byId('npStatus').value = 'backlog';
  byId('npPriority').innerHTML = ['none','urgent','high','medium','low']
    .map((p) => `<option value="${p}">${PRI_LABEL[p] || '无'}</option>`).join('');
  byId('npPriority').value = 'none';
}

// 启动
switchView('mini');
bindEvents();
initNewPanel();
connectEvents();
loadData().catch(() => setOnline(false));
startPolling();
