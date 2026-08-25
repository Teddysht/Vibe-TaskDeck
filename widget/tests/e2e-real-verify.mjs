// 真机端到端验证：连接 cargo tauri dev 的真实 WebView2 窗口（真实 Rust command + SQLite）。
// 不注入任何 mock——数据全走真实链路。
//   1. 启动即数据加载（真实 load_data，无离线提示）
//   2. 新建任务（create_task → SQLite → 事件刷新）
//   3. 列表流转（move_task 真实乐观并发 version）
//   4. 筛选复位（P1-1 真机回归）
//   5. 详情流转（P2-2 真机回归）
//   6. agent 徽标：用 taskctl 造一条 agent 任务对比（若 taskctl 可用）
// 注意：真实库可能有既有任务，断言全部基于「本脚本新建的任务」定位。
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';

const DEBUG_PORT = Number(process.env.WIDGET_CDP_PORT || 8490);
const OUT = path.resolve('.out', 'e2e-real-result.json');
const SHOTS = path.resolve('.out', 'e2e-shot');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

function run(cmd, args, opts = {}) {
  return new Promise((res) => {
    execFile(cmd, args, { timeout: 30000, ...opts }, (err, stdout, stderr) => {
      res({ err, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function main() {
  // 找到挂件主窗（mini）页面的 CDP target。
  // 注意：fullboard 第二窗口打开后 targets 有两个页面，其标题也含 'taskboard'，
  // 必须优先精确匹配 mini.html（本套件只测主窗 UI）。
  const list = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then(r => r.json());
  const page =
    list.find(t => t.type === 'page' && t.url.includes('mini.html')) ||
    list.find(t => t.type === 'page' && (t.url.includes('index.html') || t.title.includes('taskboard')));
  if (!page) {
    console.log('可用 targets:', list.map(t => `${t.type}:${t.url}`).join('\n'));
    throw new Error('未找到挂件页面 target');
  }
  console.log('连接 target:', page.url);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let msgId = 0;
  const pending = new Map();
  const consoleLog = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = (m.params.args || []).map(a => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' ');
      consoleLog.push({ type: m.params.type, text });
    }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++msgId;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result?.result?.value;
  };
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, name), Buffer.from(s.result.data, 'base64'));
  };

  await send('Runtime.enable');
  await send('Page.enable');
  fs.mkdirSync(SHOTS, { recursive: true });

  // ---- 状态复位：不依赖上一个脚本留下的视图状态（detail 归位、收起回 mini） ----
  await evalJs(`(() => {
    const s = __widgetStore.getState();
    if (s.largeView === 'detail') s.closeDetail();        // 详情覆盖层先退
    if (document.getElementById('large').style.display !== 'none') {
      document.getElementById('collapseBtn').click();     // large 可见时经真实交互收起
    }
    return 'reset';
  })()`);
  await sleep(400);

  const TAG = 'E2E-' + Date.now().toString(36);
  const titleOf = (label) => `${TAG}-${label}`;

  // ---- 1. 启动数据加载 ----
  await sleep(1000);
  const boot = await evalJs(`(() => ({
    online: __widgetStore.getState().online,
    taskCount: __widgetStore.getState().tasks.length,
    offlineHidden: document.getElementById('offline').style.display === 'none' || getComputedStyle(document.getElementById('offline')).display === 'none',
    miniShown: document.getElementById('mini').style.display !== 'none',
  }))()`);
  check('1a 启动后在线（真实 load_data 成功）', boot.online === true, `tasks=${boot.taskCount}`);
  check('1b mini 胶囊可见', boot.miniShown === true);

  await shot('01-mini.png');

  // ---- 2. 新建任务（表单 → create_task → SQLite → 事件刷新） ----
  await evalJs(`document.getElementById('miniBody').click(); 'ok'`);
  await sleep(500);
  const expanded = await evalJs(`document.getElementById('large').style.display`);
  check('2a 点胶囊展开 large', expanded === 'flex', `display=${expanded}`);

  await evalJs(`document.getElementById('newBtn').click(); 'ok'`);
  await sleep(300);
  await evalJs(`(() => {
    document.getElementById('npTitle').value = ${JSON.stringify(titleOf('创建'))};
    document.getElementById('npStatus').value = 'todo';
    return 'filled';
  })()`);
  await evalJs(`document.getElementById('npSubmit').click(); 'ok'`);
  await sleep(1000);
  const created = await evalJs(`(() => {
    const t = __widgetStore.getState().tasks.find(t => t.title === ${JSON.stringify(titleOf('创建'))});
    return t ? { id: t.id, status: t.status, version: t.version } : null;
  })()`);
  check('2b 新建任务进入 state（真实 SQLite 写入）', !!created, created ? `id=${created.id} version=${created.version}` : '未找到');
  const createdId = created?.id;

  // ---- 3. 列表流转（真实乐观并发） ----
  if (createdId) {
    await evalJs(`(() => {
      const item = document.querySelector('#list .item[data-id="${createdId}"] button[data-a="in_progress"]');
      if (item) item.click();
      return item ? 'clicked' : 'no-button';
    })()`);
    await sleep(1000);
    const moved = await evalJs(`(() => {
      const t = __widgetStore.getState().tasks.find(t => t.id === '${createdId}');
      return t ? { status: t.status, version: t.version } : null;
    })()`);
    check('3a 列表流转 todo → in_progress（真实 version 并发）', moved?.status === 'in_progress', moved ? `version=${moved.version}` : '任务丢失');

    // ---- 4. 筛选复位（P1-1 真机） ----
    await evalJs(`document.querySelector('#counts .c[data-s="todo"]').click(); 'ok'`);
    await sleep(300);
    const filteredOut = await evalJs(`(() => {
      const visible = [...document.querySelectorAll('#list .item')].some(i => i.dataset.id === '${createdId}');
      return { visible, total: document.querySelectorAll('#list .item').length };
    })()`);
    check('4a todo 筛选下 in_progress 任务不可见', filteredOut.visible === false, `列表 ${filteredOut.total} 条`);
    await evalJs(`document.querySelector('#counts .c[data-s="all"]').click(); 'ok'`);
    await sleep(300);
    const back = await evalJs(`(() => {
      const visible = [...document.querySelectorAll('#list .item')].some(i => i.dataset.id === '${createdId}');
      return visible;
    })()`);
    check('4b 「全部」复位后任务回来（P1-1 真机）', back === true);

    // ---- 5. 详情流转（P2-2 真机） ----
    await evalJs(`(() => {
      const item = document.querySelector('#list .item[data-id="${createdId}"]');
      if (item) item.click();
      return item ? 'opened' : 'missing';
    })()`);
    await sleep(600);
    const detailOpen = await evalJs(`document.getElementById('detail').style.display`);
    check('5a 点条目打开详情（真实 issue_detail）', detailOpen === 'flex', `display=${detailOpen}`);

    const actBefore = await evalJs(`[...document.querySelectorAll('#dAct button')].map(b => b.textContent + ':' + b.dataset.a)`);
    check('5b in_progress 详情动作条 = 推进+完成', Array.isArray(actBefore) && actBefore.join(',') === '推进:in_review,完成:done', JSON.stringify(actBefore));

    await shot('02-detail.png');

    await evalJs(`(() => {
      const b = document.querySelector('#dAct button[data-a="done"]');
      if (b) b.click();
      return b ? 'clicked' : 'missing';
    })()`);
    await sleep(1000);
    const doneStatus = await evalJs(`(() => {
      const t = __widgetStore.getState().tasks.find(t => t.id === '${createdId}');
      const badge = document.getElementById('dStatus').textContent;
      const acts = document.querySelectorAll('#dAct button').length;
      return { status: t?.status, badge, acts };
    })()`);
    check('5c 详情流转 in_progress → done（真实链路）', doneStatus.status === 'done' && doneStatus.badge === '已完成' && doneStatus.acts === 0,
      `status=${doneStatus.status} badge=${doneStatus.badge} acts=${doneStatus.acts}`);

    // ---- 6. 真实版本冲突（P1-2 真机：外部改库后流转） ----
    // 把任务改回 in_progress（外部直接动 state 不行——用详情动作条已消失，通过新建一条 todo 再测）
    await evalJs(`document.getElementById('dBack').click(); 'ok'`);
    await sleep(300);
  }

  // 新建第二条用于冲突测试：直接调 invoke 用过期 version
  const conflictTest = await evalJs(`(async () => {
    try{
      // 新建 todo 任务
      const created = await window.__TAURI_INTERNALS__.invoke('create_task', { title: ${JSON.stringify(titleOf('冲突'))}, status: 'todo', priority: 'none', dueDate: null });
      // 等 task-created 事件触发的 loadData 完成（轮询兜底前事件刷新有延迟，400ms 不够）
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 200));
        if (__widgetStore.getState().tasks.find(t => t.title === ${JSON.stringify(titleOf('冲突'))})) break;
      }
      const fresh = __widgetStore.getState().tasks.find(t => t.title === ${JSON.stringify(titleOf('冲突'))});
      if (!fresh) return { step: 'find', ok: false };
      // 用过期 version=999 调 move_task → 期待 VERSION_CONFLICT → moveTask 内部重读重试成功
      const r = await window.__widgetApi.moveTask({ id: fresh.id, version: 999 }, 'in_progress');
      // 等 moveTask 尾部 loadData 把最新状态刷进 store
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 200));
        const t = __widgetStore.getState().tasks.find(t => t.id === fresh.id);
        if (t && t.status === 'in_progress') break;
      }
      const after = __widgetStore.getState().tasks.find(t => t.id === fresh.id);
      return { step: 'move', ok: after?.status === 'in_progress', status: after?.status, version: after?.version };
    }catch(e){
      return { step: 'throw', ok: false, err: String(e && (e.message || e)) };
    }
  })()`);
  check('6a 过期 version 流转经冲突重试成功（P1-2 真机路径）', conflictTest?.ok === true, JSON.stringify(conflictTest));

  // ---- 7. agent 任务徽标（真实 creatorType 数据） ----
  const agentInDb = await evalJs(`__widgetStore.getState().tasks.filter(t => t.creatorType === 'agent').length`);
  const userTask = await evalJs(`(() => {
    const t = __widgetStore.getState().tasks.find(t => t.creatorType !== 'agent');
    if (!t) return null;
    const item = document.querySelector('#list .item[data-id="' + t.id + '"] .ag');
    return { hasBadge: !!item, title: t.title.slice(0, 20) };
  })()`);
  if (userTask) {
    check('7a user 任务无 AI 徽标（真实数据）', userTask.hasBadge === false, `"${userTask.title}"`);
  }
  console.log(`（库中 agent 任务 ${agentInDb} 条${agentInDb > 0 ? '，徽标渲染已由 mock 层验证覆盖' : '，agent 路径由 mock 层验证覆盖'}）`);

  // ---- 8. 收起回 mini ----
  await evalJs(`document.getElementById('collapseBtn').click(); 'ok'`);
  await sleep(400);
  const miniBack = await evalJs(`document.getElementById('mini').style.display`);
  check('8a 收起回 mini 胶囊', miniBack === 'flex', `display=${miniBack}`);
  await shot('03-mini-back.png');

  // ---- 控制台错误扫描 ----
  const errors = consoleLog.filter(l => l.type === 'error');
  check('9a 控制台无未处理错误', errors.length === 0, errors.map(e => e.text.slice(0, 80)).join(' | ') || '干净');

  fs.writeFileSync(OUT, JSON.stringify({ results, consoleLog }, null, 2), 'utf8');
  console.log('---');
  console.log(`结果: ${results.filter(r => r.pass).length}/${results.length} 通过；截图目录: ${SHOTS}`);
  // 不关闭真机窗口（Browser.close 会杀掉挂件本体），只断开 WS
  ws.close();
}

main().then(() => process.exit(results.some(r => !r.pass) ? 2 : 0))
  .catch((e) => { console.error('FATAL', e); process.exit(1); });
