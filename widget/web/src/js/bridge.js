/* ============================================================
 * bridge —— Tauri 桥 + 两级窗口切换（依赖 config + state + render-mini）
 *
 * 设计：不依赖任何 Tauri 插件，全部走自定义 Rust command（invoke），
 *       规避插件权限名与全局 API 模块路径的不确定性。
 *   - set_window_size / close_window 由 commands.rs 提供
 *   - 浏览器直开时 window.__TAURI__ 为 undefined，走退化逻辑
 * ============================================================ */

// 调用 Rust command；无 Tauri 环境返回已拒绝的 Promise
function _invoke(cmd, args){
  const inv = window.__TAURI__?.core?.invoke;
  if (typeof inv === 'function'){
    return Promise.resolve(inv(cmd, args));
  }
  return Promise.reject(new Error('no tauri'));
}

function hasTauri(){ return typeof window.__TAURI__?.core?.invoke === 'function'; }

// 调整宿主窗口尺寸
function setSize(w, h){
  if (hasTauri()){ _invoke('set_window_size', { w, h }).catch(() => {}); }
}

// 两级切换：窗口尺寸瞬变 + 内容过渡衔接（展开 180ms 从胶囊位置长出；收起 120ms 快速淡出）
// 守卫只拦截「已初始化后的重复切换」：state.view 初始为 null（state.js），
// 首次 switchView('mini') 会走完整路径——解除容器隐藏并启动轮转。
// 若把初始值设回 'mini'，启动调用会被同值守卫早退，两容器保持内联
// display:none，页面只剩 body 背景（曾导致整窗黑屏，勿回退）。
// 布局切换按钮的图标对（P2-1：图标显示目标视图，与 boardBtn 外链图标语义区分）
const ICON_BOARD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="6" height="16" rx="1.5"/><rect x="10" y="4" width="6" height="10" rx="1.5"/><rect x="17" y="4" width="4" height="13" rx="1.5"/></svg>';
const ICON_LIST = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>';

// large 内部布局切换：'list'（360×520）↔ 'board'（920×560）
// detail 覆盖层不属于布局（不动窗口尺寸）；切换只在非 detail 态下发生
function switchLargeLayout(layout){
  if (layout === state.largeView || state.largeView === 'detail') return;
  state.largeView = layout;
  if (layout === 'board'){
    byId('list').style.display = 'none';
    byId('empty').style.display = 'none';
    byId('counts').style.display = 'none';
    byId('viewToggle').title = '切换回列表视图';
    byId('viewToggle').innerHTML = ICON_LIST;   // 显示目标视图（列表）
    setSize(SIZES.board.w, SIZES.board.h);
    renderBoard();
  } else {
    byId('board').style.display = 'none';
    byId('counts').style.display = 'flex';
    byId('viewToggle').title = '切换看板视图';
    byId('viewToggle').innerHTML = ICON_BOARD;  // 显示目标视图（看板）
    setSize(SIZES.large.w, SIZES.large.h);
    renderLarge();
  }
}

function switchView(view){
  const mini = byId('mini');
  const large = byId('large');
  if (view === state.view) return;
  state.view = view;

  if (view === 'large'){
    // 展开：先显示 large（entering 态）→ 调窗口尺寸 → 下一帧移除 entering 触发过渡
    // 尺寸/内容按离开时的布局恢复（list 360×520 / board 920×560）
    const board = state.largeView === 'board';
    large.style.display = 'flex';
    large.classList.add('entering');
    mini.style.display = 'none';
    mini.classList.remove('entering');
    setSize(board ? SIZES.board.w : SIZES.large.w, board ? SIZES.board.h : SIZES.large.h);
    stopRotate();
    if (board){ renderBoard(); } else { renderLarge(); }
    requestAnimationFrame(() => requestAnimationFrame(() => large.classList.remove('entering')));
  } else {
    // 收起时若处于详情子视图，静默重置（否则下次展开卡在覆盖层）；看板布局保留记忆
    if (state.largeView === 'detail'){
      state.largeView = state.detailFrom === 'board' ? 'board' : 'list';
      state.detailId = null;
      state.detail = null;
      byId('detail').style.display = 'none';
    }
    // 收起：large 快速淡出 → 结束后切 mini 并淡入
    large.classList.add('leaving');
    setTimeout(() => {
      large.style.display = 'none';
      large.classList.remove('leaving');
      mini.style.display = 'flex';
      mini.classList.add('entering');
      setSize(SIZES.mini.w, SIZES.mini.h);
      startRotate();
      requestAnimationFrame(() => requestAnimationFrame(() => mini.classList.remove('entering')));
    }, 120);
  }
}

// 退出挂件
function closeWidget(){
  if (hasTauri()){ _invoke('close_window', {}).catch(() => {}); }
}
