// P1 修复实测：无头 Chrome + CDP 打开 widget/dist/mini.html，注入 mock __TAURI__。
// 验证点：
//   P1-1 计数条有「全部」chip，点入状态后可复位回 all（单向门消除）
//   P1-2 move_task 持续 VERSION_CONFLICT 时，toast 显示错误（不再静默）
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const PORT = 8473;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEBUG_PORT = 8483;
const PROFILE = path.resolve('.out', 'profile-verify');
const PAGE_URL = `http://localhost:${PORT}/mini.html`;
const OUT = path.resolve('.out', 'p1-verify-result.json');
const SHOT_LIST = path.resolve('.out', 'p1-shot-list.png');
const SHOT_TOAST = path.resolve('.out', 'p1-shot-toast.png');

// ---- mock 任务数据：6 状态各 1 条 + todo 再加 1 条，便于计数断言 ----
const MOCK_TASKS = [
  { id: 'T-1', title: '积压事项', identifier: 'TSK-1', status: 'backlog',    priority: 'none',   dueDate: null, version: 1 },
  { id: 'T-2', title: '待办甲',   identifier: 'TSK-2', status: 'todo',       priority: 'high',   dueDate: null, version: 1 },
  { id: 'T-3', title: '待办乙',   identifier: 'TSK-3', status: 'todo',       priority: 'none',   dueDate: null, version: 1 },
  { id: 'T-4', title: '进行中',   identifier: 'TSK-4', status: 'in_progress',priority: 'none',   dueDate: null, version: 1 },
  { id: 'T-5', title: '待评审',   identifier: 'TSK-5', status: 'in_review',  priority: 'none',   dueDate: null, version: 1 },
  { id: 'T-6', title: '被阻塞',   identifier: 'TSK-6', status: 'blocked',    priority: 'urgent', dueDate: null, version: 1 },
  { id: 'T-7', title: '已完成',   identifier: 'TSK-7', status: 'done',       priority: 'none',   dueDate: null, version: 1 },
];

// 页面加载前注入：mock Tauri internals（@tauri-apps/api 走 __TAURI_INTERNALS__.invoke）
const MOCK_JS = `
// 颜色/对比度断言锁定暗色主题（防 headless Chrome 默认 prefers-light 触发亮色映射）
try { localStorage.setItem('taskboard-theme', 'dark'); } catch (e) {} // THEME-BOOT 内联脚本读到 dark（注入期 documentElement 可能为 null，勿在此直接设 className）

window.__TAURI_INTERNALS__ = {
  invoke(cmd, args) {
    if (cmd === 'plugin:event|listen') return Promise.resolve(1);
    if (cmd === 'plugin:event|unlisten') return Promise.resolve();
    if (cmd === 'load_data') {
      return Promise.resolve({ tasks: ${JSON.stringify(MOCK_TASKS)}, projects: [{ id: 'local', name: '本地' }] });
    }
    if (cmd === 'move_task') {
      return Promise.reject({ code: 'VERSION_CONFLICT', message: 'version conflict (mock)' });
    }
    return Promise.resolve({});
  },
  transformCallback: () => 0,
};
`;

const MIME = { '.html': 'text/html; charset=utf-8' };
const server = http.createServer((req, res) => {
  fs.readFile(path.join(ROOT, 'mini.html'), (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(data);
  });
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, timeout = 45000, step = 200) {
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
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=480,720', 'about:blank',
], { stdio: 'ignore' });

const consoleLog = [];

async function main() {
  await new Promise(r => server.listen(PORT, r));
  await waitFor(async () => {
    const v = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`).then(r => r.json()).catch((e) => { console.log('  [debug] fetch err:', e.message, 'chrome exitCode=', chrome.exitCode, 'pid=', chrome.pid); return null; });
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
    return r.result?.result?.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  // 关键：导航前注入 mock，让 api.js 的 _cmd 走 mock 而非 no-tauri 分支
  await send('Page.addScriptToEvaluateOnNewDocument', { source: MOCK_JS });
  await send('Page.navigate', { url: PAGE_URL });
  await sleep(1200);

  // 进入 large 视图
  await evalJs(`document.getElementById('expandBtn').click(); 'clicked'`);
  await sleep(600);

  // ---- P1-1：全部 chip 存在 + 可复位 ----
  const allChip = await evalJs(`(() => {
    const c = document.querySelector('#counts .c[data-s="all"]');
    return c ? { label: c.querySelector('.l').textContent, n: c.querySelector('.n').textContent, on: c.classList.contains('on') } : null;
  })()`);
  check('P1-1a 计数条存在「全部」chip', !!allChip, allChip ? `label=${allChip.label} 计数=${allChip.n}` : '未找到');
  check('P1-1b 全部 chip 计数=任务总数(7)', allChip && allChip.n === '7', `n=${allChip?.n}`);

  // 点击 todo 状态 chip → 筛选生效
  await evalJs(`document.querySelector('#counts .c[data-s="todo"]').click(); 'ok'`);
  await sleep(300);
  const filtered = await evalJs(`(() => ({
    items: document.querySelectorAll('#list .item').length,
    todoOn: document.querySelector('#counts .c[data-s="todo"]').classList.contains('on'),
    allOn: document.querySelector('#counts .c[data-s="all"]').classList.contains('on'),
  }))()`);
  check('P1-1c 点 todo chip 后列表只剩 2 条', filtered.items === 2, `items=${filtered.items}`);
  check('P1-1d todo chip 高亮 / 全部 chip 取消高亮', filtered.todoOn === true && filtered.allOn === false, `todoOn=${filtered.todoOn} allOn=${filtered.allOn}`);

  // 点「全部」chip → 复位（单向门消除的核心断言）
  await evalJs(`document.querySelector('#counts .c[data-s="all"]').click(); 'ok'`);
  await sleep(300);
  const reset = await evalJs(`(() => ({
    items: document.querySelectorAll('#list .item').length,
    allOn: document.querySelector('#counts .c[data-s="all"]').classList.contains('on'),
    todoOn: document.querySelector('#counts .c[data-s="todo"]').classList.contains('on'),
  }))()`);
  check('P1-1e 点「全部」chip 列表恢复 7 条', reset.items === 7, `items=${reset.items}`);
  check('P1-1f 全部 chip 高亮 / todo 取消高亮', reset.allOn === true && reset.todoOn === false, `allOn=${reset.allOn} todoOn=${reset.todoOn}`);

  // 列表态截图
  const shot1 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(SHOT_LIST, Buffer.from(shot1.result.data, 'base64'));

  // ---- P1-2：流转失败 toast ----
  // 点第一条 todo 的「认领」按钮 → move_task 持续冲突 → 应弹 toast
  await evalJs(`document.querySelector('#list .item[data-id="T-2"] button[data-a="in_progress"]').click(); 'ok'`);
  await sleep(800);
  const toast = await evalJs(`(() => {
    const t = document.getElementById('toast');
    if (!t) return null;
    return { text: t.textContent, show: t.classList.contains('show'), error: t.classList.contains('error') };
  })()`);
  check('P1-2a toast 出现且内容为冲突提示', !!toast && toast.show === true && toast.text === '任务刚被外部修改，请重试',
    toast ? `text="${toast.text}" show=${toast.show} error=${toast.error}` : '无 toast 元素');
  check('P1-2b toast 为警示色(error class)', !!toast && toast.error === true, `error=${toast?.error}`);
  check('P1-2c 后台 console.error 记录 move failed', consoleLog.some(l => l.type === 'error' && l.text.includes('move failed')),
    `错误日志 ${consoleLog.filter(l => l.type === 'error').length} 条`);
  // 任务状态未被本地误改（仍 todo）
  const stillTodo = await evalJs(`(__widgetStore.getState().tasks.find(t => t.id === 'T-2') || {}).status`);
  check('P1-2d 冲突后任务状态未被误改为流转目标', stillTodo === 'todo', `status=${stillTodo}`);

  // toast 态截图
  const shot2 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(SHOT_TOAST, Buffer.from(shot2.result.data, 'base64'));

  fs.writeFileSync(OUT, JSON.stringify({ results, consoleMessages: consoleLog }, null, 2), 'utf8');
  console.log('---');
  console.log(`结果: ${results.filter(r => r.pass).length}/${results.length} 通过；截图: ${SHOT_LIST}, ${SHOT_TOAST}`);
  // 优雅关闭整个浏览器（chrome.kill 只杀主进程，渲染进程会变孤儿并锁住 profile）
  await send('Browser.close').catch(() => {});
  await sleep(1500);
  ws.close();
  server.close();
}

main().then(() => { setTimeout(() => process.exit(results.some(r => !r.pass) ? 2 : 0), 2500); })
  .catch((e) => { console.error('FATAL', e); server.close(); process.exit(1); });
