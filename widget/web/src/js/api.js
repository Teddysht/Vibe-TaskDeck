/* ============================================================
 * api —— 数据层：Tauri invoke / 事件 / 轮询（依赖 config + state）
 *
 * 纯客户端架构：不再有 HTTP 服务，读写全部走 Rust command 直连 SQLite。
 *   · 挂件自身的写操作 → Rust emit task.created/task.moved → 即时刷新
 *   · 外部写入（taskctl / server 模式同库）→ 靠轮询兜底发现
 * ============================================================ */

// 调用 Rust command；无 Tauri 环境（浏览器直开 dist/mini.html）时拒绝
async function _cmd(name, args){
  const inv = window.__TAURI__?.core?.invoke;
  if (typeof inv !== 'function') throw new Error('no tauri');
  return inv(name, args);
}

// 拉取任务与项目
async function loadData(){
  const data = await _cmd('load_data');
  setData(data.tasks || [], data.projects || [], true);
}

// 新建任务（挂件表单）
async function createTask(input){
  return _cmd('create_task', input);
}

// 写操作：move（乐观并发，version 过期 → 重读重试一次）
async function moveTask(task, status){
  const doMove = async (version) => {
    try{
      return await _cmd('move_task', { id: task.id, version, status });
    }catch(e){
      if (e && e.code === 'VERSION_CONFLICT') return { conflict: true };
      throw e;
    }
  };

  let result = await doMove(task.version);
  if (result && result.conflict){
    // 版本过期：重读最新 version 后重试一次
    await loadData().catch(() => {});
    const fresh = state.tasks.find((t) => t.id === task.id);
    if (fresh && fresh.version){ result = await doMove(fresh.version); }
  }
  // 无论成败都刷新一次（成功用最新数据；仍冲突则靠轮询兜底）
  await loadData().catch(() => {});
}

// 任务详情（L3-本机：task 全字段 + 评论 + 活动流）
async function issueDetail(id){
  return _cmd('issue_detail', { id });
}

// 发表评论（归属挂件会话）
async function addComment(taskId, body){
  return _cmd('add_comment', { taskId, body });
}

// L3-全版：拉起 server + 开第二窗口（Rust 侧完成，可能耗时 ~20s）
async function openFullBoard(){
  return _cmd('open_full_board');
}

// Tauri 事件：挂件自身写操作后的即时刷新（替代原 SSE）
function connectEvents(){
  const listen = window.__TAURI__?.event?.listen;
  if (typeof listen !== 'function') return;
  ['task.created','task.moved'].forEach((name) => {
    listen(name, () => { loadData().catch(() => setOnline(false)); }).catch(() => {});
  });
  // 评论写入：详情开着时刷新详情（列表不展示评论数，无需重拉）
  listen('task.comment', () => { refreshDetail().catch(() => {}); }).catch(() => {});
}

// 后台轮询（在线中频刷新 / 离线快速重试；同时是感知外部写入的唯一机制）
function startPolling(){
  const tick = async () => {
    try{
      await loadData();
      // 详情开着时顺带刷新（外部 taskctl/server 可能改了任务状态或评论）
      if (state.largeView === 'detail'){ await refreshDetail(); }
    }
    catch(e){ setOnline(false); }
    setTimeout(tick, state.online ? POLL_OK_MS : RETRY_MS);
  };
  setTimeout(tick, POLL_OK_MS);
}
