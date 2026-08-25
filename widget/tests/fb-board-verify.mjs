// FB 看板核心实测：无头 Chrome + CDP 打开 widget/dist/fullboard.html，注入 mock __TAURI_INTERNALS__。
// 验证点：
//   FB-1 七列渲染 + 卡片归列正确
//   FB-2 模拟拖拽落点（drop 事件带 beforeTaskId）→ move_task 收到中值 sortOrder
//   FB-3 跨列 drop → 状态流转 + 刷新重渲染
//   FB-4 VERSION_CONFLICT → 单次重读重试成功
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/git/Vibe-TaskDeck/widget/dist';
const PORT = 8479;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEBUG_PORT = 8497;
const PROFILE = path.resolve('.out', 'profile-fbboard');
const PAGE_URL = `http://localhost:${PORT}/fullboard.html`;
const OUT = path.resolve('.out', 'fb-board-verify-result.json');
const SHOT = path.resolve('.out', 'fb-board-shot.png');

// mock 任务：3 列有任务，todo 列 3 条用于中值排序断言
const MOCK_TASKS = [
  { id: 'T-1', title: '积压A', identifier: 'TSK-1', status: 'backlog',     priority: 'none', dueDate: null, version: 1, sortOrder: 1000, createdAt: '2026-08-20T10:00:00.000Z', creatorType: 'user' },
  { id: 'T-2', title: '待办一', identifier: 'TSK-2', status: 'todo',       priority: 'high', dueDate: null, version: 1, sortOrder: 1000, createdAt: '2026-08-20T10:01:00.000Z', creatorType: 'user' },
  { id: 'T-3', title: '待办二', identifier: 'TSK-3', status: 'todo',       priority: 'none', dueDate: null, version: 1, sortOrder: 2000, createdAt: '2026-08-20T10:02:00.000Z', creatorType: 'user' },
  { id: 'T-4', title: '待办三', identifier: 'TSK-4', status: 'todo',       priority: 'none', dueDate: null, version: 1, sortOrder: 3000, createdAt: '2026-08-20T10:03:00.000Z', creatorType: 'agent' },
  { id: 'T-5', title: '进行中', identifier: 'TSK-5', status: 'in_progress',priority: 'none', dueDate: null, version: 1, sortOrder: 1000, createdAt: '2026-08-20T10:04:00.000Z', creatorType: 'user' },
  { id: 'T-6', title: '已完成', identifier: 'TSK-6', status: 'done',       priority: 'none', dueDate: null, version: 1, sortOrder: 1000, createdAt: '2026-08-20T10:05:00.000Z', creatorType: 'user' },
];

// 记录 move_task 收到的参数（断言 sortOrder 中值）
const MOCK_JS = `
// 颜色/对比度断言锁定暗色主题（防 headless Chrome 默认 prefers-light 触发亮色映射）
try { localStorage.setItem('taskboard-theme', 'dark'); } catch (e) {} // THEME-BOOT 内联脚本读到 dark（注入期 documentElement 可能为 null，勿在此直接设 className）

window.__MOVES__ = [];
window.__FAIL_NEXT_MOVE__ = false;
window.__TASKS__ = ${JSON.stringify(MOCK_TASKS)};
window.__TAURI_INTERNALS__ = {
  invoke(cmd, args) {
    if (cmd === 'plugin:event|listen') return Promise.resolve(1);
    if (cmd === 'plugin:event|unlisten') return Promise.resolve();
    if (cmd === 'load_data') {
      return Promise.resolve({ tasks: window.__TASKS__, projects: [{ id: 'local', name: '全局' }] });
    }
    if (cmd === 'move_task') {
      window.__MOVES__.push(args);
      if (window.__FAIL_NEXT_MOVE__) {
        window.__FAIL_NEXT_MOVE__ = false;
        return Promise.reject({ code: 'VERSION_CONFLICT', message: 'conflict (mock)' });
      }
      const t = window.__TASKS__.find(t => t.id === args.id);
      if (!t) return Promise.reject({ code: 'TASK_NOT_FOUND', message: 'gone' });
      if (t.version !== args.version) return Promise.reject({ code: 'VERSION_CONFLICT', message: 'conflict' });
      t.status = args.status; t.sortOrder = args.sortOrder; t.version += 1;
      return Promise.resolve({ ...t });
    }
    return Promise.resolve({});
  },
  transformCallback: () => 0,
};
`;

const server = http.createServer((req, res) => {
  fs.readFile(path.join(ROOT, 'fullboard.html'), (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, timeout = 15000, step = 200) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await fn(); if (v) return v; } catch {}
    await sleep(step);
  }
  throw new Error('timeout');
}

fs.mkdirSync(path.resolve('.out'), { recursive: true });
const results = [];
const check = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1280,800', 'about:blank',
], { stdio: 'ignore' });

async function main() {
  await new Promise(r => server.listen(PORT, r));
  await waitFor(async () => {
    const v = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`).then(r => r.json()).catch(() => null);
    return v && v.webSocketDebuggerUrl;
  });

  const target = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?${PAGE_URL}`, { method: 'PUT' }).then(r => r.json());
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++msgId;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r.result?.result?.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: MOCK_JS });
  await send('Page.navigate', { url: PAGE_URL });
  await sleep(1500);

  // ---- FB-1 七列 + 归列 ----
  const layout = await evalJs(`(() => ({
    cols: document.querySelectorAll('.fb-col').length,
    todoCards: document.querySelectorAll('.fb-col[data-status="todo"] [data-task-id]').length,
    backlogCards: document.querySelectorAll('.fb-col[data-status="backlog"] [data-task-id]').length,
    doneCards: document.querySelectorAll('.fb-col[data-status="done"] [data-task-id]').length,
    emptyCols: document.querySelectorAll('.col-empty').length,
    agentBadges: document.querySelectorAll('.fb-card .ag').length,
  }))()`);
  check('FB-1a 七列渲染', layout.cols === 7, `cols=${layout.cols}`);
  check('FB-1b 任务归列正确（todo=3 backlog=1 done=1）',
    layout.todoCards === 3 && layout.backlogCards === 1 && layout.doneCards === 1,
    `todo=${layout.todoCards} backlog=${layout.backlogCards} done=${layout.doneCards}`);
  check('FB-1c 空列显示占位（in_review/blocked/canceled 共 3 列）', layout.emptyCols === 3, `empty=${layout.emptyCols}`);
  check('FB-1d agent 卡片有 AI 徽标', layout.agentBadges === 1, `badges=${layout.agentBadges}`);

  // ---- FB-2 模拟拖拽：T-1(backlog) 拖到 todo 列、落在 T-3 之前 → sortOrder=(1000+2000)/2=1500 ----
  const dropResult = await evalJs(`(async () => {
    const col = document.querySelector('.fb-col[data-status="todo"]');
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('application/x-taskboard-task', 'T-1');
    col.dispatchEvent(new DragEvent('dragenter', { bubbles: true }));
    col.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
    const before = document.querySelector('.fb-col[data-status="todo"] [data-task-id="T-3"]');
    // 直接构造 drop：beforeTaskId 逻辑在 handleDrop 内按 clientY 计算——
    // headless 下用真实坐标调用内部逻辑等价：调用列的 onDrop 前手动模拟 findDropBefore 结果
    // 这里直接在 T-3 卡片位置合成 drop（clientY = T-3 顶部）
    const rect = before.getBoundingClientRect();
    col.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, clientY: rect.top + 1 }));
    await new Promise(r => setTimeout(r, 400));
    return {
      moves: window.__MOVES__,
      todoCards: document.querySelectorAll('.fb-col[data-status="todo"] [data-task-id]').length,
      backlogCards: document.querySelectorAll('.fb-col[data-status="backlog"] [data-task-id]').length,
    };
  })()`);
  const move = dropResult.moves?.[0];
  check('FB-2a move_task 收到目标状态', move?.status === 'todo', JSON.stringify(move));
  check('FB-2b 落点中值 sortOrder=1500（T-2 与 T-3 之间）', move?.sortOrder === 1500, `sortOrder=${move?.sortOrder}`);
  check('FB-2c 跨列后重渲染（todo=4 backlog=0）',
    dropResult.todoCards === 4 && dropResult.backlogCards === 0,
    `todo=${dropResult.todoCards} backlog=${dropResult.backlogCards}`);

  // ---- FB-3 todo 列内重排：T-4 拖到列首（T-2 之前）→ sortOrder=1000-1000=0 ----
  const reorder = await evalJs(`(async () => {
    const col = document.querySelector('.fb-col[data-status="todo"]');
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('application/x-taskboard-task', 'T-4');
    col.dispatchEvent(new DragEvent('dragenter', { bubbles: true }));
    col.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
    const first = document.querySelector('.fb-col[data-status="todo"] [data-task-id="T-2"]');
    const rect = first.getBoundingClientRect();
    col.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, clientY: rect.top + 1 }));
    await new Promise(r => setTimeout(r, 400));
    return { moves: window.__MOVES__ };
  })()`);
  const reorderMove = reorder.moves?.[reorder.moves.length - 1];
  check('FB-3a 列首落点 sortOrder=0（首位 min-1000）', reorderMove?.sortOrder === 0, `sortOrder=${reorderMove?.sortOrder}`);

  // ---- FB-4 冲突重试：T-5(进行中) 拖到 done；mock 首次强制 VERSION_CONFLICT → 重读后重试成功 ----
  const conflict = await evalJs(`(async () => {
    window.__FAIL_NEXT_MOVE__ = true;
    const col = document.querySelector('.fb-col[data-status="done"]');
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('application/x-taskboard-task', 'T-5');
    col.dispatchEvent(new DragEvent('dragenter', { bubbles: true }));
    col.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
    const before = document.querySelector('.fb-col[data-status="done"] [data-task-id]');
    const rect = before.getBoundingClientRect();
    col.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, clientY: rect.top + 1 }));
    await new Promise(r => setTimeout(r, 600));
    return { moves: window.__MOVES__.filter(m => m.id === 'T-5') };
  })()`);
  check('FB-4a 冲突后单次重试成功（T-5 两次 move 调用）', conflict.moves?.length === 2, `moves=${conflict.moves?.length}`);

  // 截图
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'));

  fs.writeFileSync(OUT, JSON.stringify({ results }, null, 2), 'utf8');
  console.log('---');
  console.log(`结果: ${results.filter(r => r.pass).length}/${results.length} 通过；截图: ${SHOT}`);
  await send('Browser.close').catch(() => {});
  await sleep(1500);
  ws.close();
  server.close();
}

main().then(() => { setTimeout(() => process.exit(results.some(r => !r.pass) ? 2 : 0), 2500); })
  .catch((e) => { console.error('FATAL', e); server.close(); process.exit(1); });
