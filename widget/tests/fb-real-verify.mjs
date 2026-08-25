// FB 真机端到端：挂件点「全版看板」→ fullboard 第二窗口（真实 Rust command + SQLite）。
// 不注入任何 mock——数据全走真实链路（页面内 __TAURI_INTERNALS__.invoke + 事件广播刷新）。
// 验证点：
//   FB-R1 点击 viewToggle → fullboard.html target 出现（第二窗口真实创建）
//   FB-R2 fullboard 加载真实数据（__widgetStore.tasks 与挂件一致）
//   FB-R3 双窗口同步：fullboard 内建任务 → 挂件 store 事件感知（task-created）
//   FB-R4 fullboard 内流转任务 → 状态/版本落库（真实 SQLite 往返）
//   FB-R5 测试任务清理（归档 → 删除）
// 前置：挂件以 WEBVIEW2_CDP_PORT（经 taskboard.py widget，数据目录 <repo>/.data）启动。
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEBUG_PORT = Number(process.env.WIDGET_CDP_PORT || 8490);
const TITLE = `FB真机验证-${Date.now().toString(36)}`;

fs.mkdirSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.out'), { recursive: true });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const evalJs = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result?.result?.value; };
  await send('Runtime.enable');
  return { ws, evalJs };
}

async function main() {
  // ---- FB-R1 点击挂件 viewToggle → fullboard 第二窗口 ----
  let list = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then(r => r.json());
  const mini = list.find(t => t.type === 'page' && t.url.includes('mini.html'));
  if (!mini) throw new Error('挂件 mini 页面未找到（需先以 WEBVIEW2_CDP_PORT 启动挂件）');

  const miniConn = await connect(mini.webSocketDebuggerUrl);
  // viewToggle 在大面板头部：胶囊状态下先展开（对齐 agent-real-verify 的展开路径）
  await miniConn.evalJs(`(() => {
    if (document.getElementById('large').style.display === 'none') document.getElementById('miniBody').click();
    return 'expanded';
  })()`);
  await sleep(600);
  await miniConn.evalJs(`document.getElementById('viewToggle')?.click(); 'ok'`);
  let fbTarget = null;
  for (let i = 0; i < 15 && !fbTarget; i++) {
    await sleep(1000);
    list = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then(r => r.json());
    fbTarget = list.find(t => t.type === 'page' && t.url.includes('fullboard.html'));
  }
  check('FB-R1a 点击挂件图标后 fullboard 第二窗口出现', !!fbTarget);

  if (!fbTarget) { miniConn.ws.close(); throw new Error('fullboard 窗口未创建'); }

  // ---- FB-R2 fullboard 加载真实数据 ----
  const fbConn = await connect(fbTarget.webSocketDebuggerUrl);
  let fbCount = null;
  for (let i = 0; i < 10 && !fbCount; i++) {
    await sleep(800);
    fbCount = await fbConn.evalJs(`(window.__widgetStore ? __widgetStore.getState().tasks.length : 0) || null`);
  }
  const miniCount = await miniConn.evalJs(`__widgetStore.getState().tasks.length`);
  check('FB-R2a fullboard 加载真实任务数据（>0）', fbCount !== null && fbCount > 0, `fb=${fbCount}`);
  check('FB-R2b 双窗口任务数一致（同一 SQLite）', fbCount === miniCount, `fb=${fbCount} mini=${miniCount}`);

  // ---- FB-R3 fullboard 建任务 → 挂件事件感知 ----
  const created = await fbConn.evalJs(`(async () => {
    try {
      const t = await window.__TAURI_INTERNALS__.invoke('create_task', { title: ${JSON.stringify(TITLE)}, status: 'todo' });
      return { ok: true, id: t.id };
    } catch (e) { return { ok: false, error: String(e) }; }
  })()`);
  check('FB-R3a fullboard 内 create_task 成功', created?.ok === true, JSON.stringify(created).slice(0, 120));

  let seenInMini = false;
  for (let i = 0; i < 12 && !seenInMini; i++) {
    await sleep(1000);
    seenInMini = await miniConn.evalJs(`__widgetStore.getState().tasks.some(t => t.title === ${JSON.stringify(TITLE)})`);
  }
  check('FB-R3b 挂件实时感知 fullboard 写入（task-created 事件）', seenInMini === true);

  // ---- FB-R4 fullboard 流转 → 状态/版本落库 ----
  let taskId = null;
  for (let i = 0; i < 10 && !taskId; i++) {
    taskId = await fbConn.evalJs(`__widgetStore.getState().tasks.find(t => t.title === ${JSON.stringify(TITLE)})?.id`);
    if (!taskId) await sleep(800);
  }
  if (taskId) {
    const updated = await fbConn.evalJs(`(async () => {
      const t = __widgetStore.getState().tasks.find(t => t.id === ${JSON.stringify(taskId)});
      try {
        await window.__TAURI_INTERNALS__.invoke('update_task', { id: t.id, version: t.version, changes: { status: 'in_progress' } });
        return { ok: true };
      } catch (e) { return { ok: false, error: String(e) }; }
    })()`);
    // fullboard 自身靠 task-updated 事件刷新；等一轮再读
    await sleep(2500);
    const moved = await fbConn.evalJs(`(() => { const t = __widgetStore.getState().tasks.find(t => t.id === ${JSON.stringify(taskId)}); return t ? { status: t.status, version: t.version } : null; })()`);
    check('FB-R4a update_task 成功', updated?.ok === true, JSON.stringify(updated).slice(0, 120));
    check('FB-R4b 流转落库（status=in_progress, version=2）',
      moved?.status === 'in_progress' && moved?.version === 2, JSON.stringify(moved));
  } else {
    check('FB-R4 fullboard 流转落库', false, '任务未在 store 中出现');
  }

  // ---- FB-R5 清理（归档 → 删除，真实链路）----
  if (taskId) {
    const cleanup = await fbConn.evalJs(`(async () => {
      const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
      const fresh = async () => {
        const data = await invoke('load_data', {});
        return (data.tasks || []).find(t => t.id === ${JSON.stringify(taskId)});
      };
      let t = await fresh();
      if (!t) return { ok: false, error: 'not found' };
      try {
        await invoke('archive_task', { id: t.id, version: t.version });
        t = await fresh(); // 归档后 version+1；重读避免事件延迟下的版本错位
        await invoke('delete_task', { id: t.id, version: t.version });
        return { ok: true };
      } catch (e) { return { ok: false, error: String(e) }; }
    })()`);
    // 删除后等事件刷新（task-deleted → loadBoardData）再断言消失
    let gone = false;
    for (let i = 0; i < 10 && !gone; i++) {
      await sleep(800);
      gone = !(await fbConn.evalJs(`__widgetStore.getState().tasks.some(t => t.id === ${JSON.stringify(taskId)})`));
    }
    check('FB-R5 测试任务清理（归档→删除）', cleanup?.ok === true && gone, JSON.stringify(cleanup).slice(0, 140));
  }

  fbConn.ws.close();
  miniConn.ws.close();
  console.log('---');
  console.log(`结果: ${results.filter(r => r.pass).length}/${results.length} 通过`);
  process.exit(results.some(r => !r.pass) ? 2 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
