// 通知动作闭环 e2e（mock 层）：mini 页面 mock __TAURI_INTERNALS__，
// listen 捕获 notification-click handler（模拟 Rust toast on_activated
// 的 emit 路径），断言前端「展开面板 + 直达任务详情」的路由行为。
// Rust 侧 diff 决策由 cargo test notify_* 三单测覆盖；toast 真实弹出
// 与点击由真机人工验证（Windows 通知中心无自动化查证 API）。
// 验证点：
//   N-1 notification-click handler 已注册（Rust emit 有消费方）
//   N-2 触发后 large 面板展开（mini 收起态 → expand）
//   N-3 详情直达目标任务（TaskDetail 显示该任务标题）
//   N-4 面板已展开时触发仅切详情（不重播 expand）
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const PORT = 8486;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEBUG_PORT = 8504;
const PROFILE = path.resolve('.out', 'profile-notify');
const PAGE_URL = `http://localhost:${PORT}/mini.html`;
const OUT = path.resolve('.out', 'notify-verify-result.json');

const MOCK_JS = `
try { localStorage.setItem('taskboard-theme', 'dark'); } catch (e) {}
window.__LISTENERS__ = {};
window.__CB__ = {}; window.__nextCbId = 0;
window.__TASKS__ = [
  { id: 'T-9', title: '待评审的AI任务', identifier: 'TSK-9', status: 'in_review', priority: 'high',
    dueDate: null, version: 1, sortOrder: 1000, createdAt: '2026-08-20T10:00:00.000Z',
    creatorType: 'agent', creatorName: 'Codex Agent', description: '', labels: [] },
  { id: 'T-8', title: '普通任务', identifier: 'TSK-8', status: 'todo', priority: 'none',
    dueDate: null, version: 1, sortOrder: 2000, createdAt: '2026-08-20T10:01:00.000Z',
    creatorType: 'user', creatorName: '本地用户', description: '', labels: [] },
];
window.__TAURI_INTERNALS__ = {
  invoke(cmd, args) {
    if (cmd === 'plugin:event|listen') {
      // 真实路径复刻：@tauri-apps/api 把 handler 经 transformCallback 注册成
      // id，listen invoke 只传 id。测试经注册表取回真函数模拟 Rust emit
      window.__LISTENERS__[args.event] = window.__CB__[args.handler];
      return Promise.resolve(1);
    }
    if (cmd === 'plugin:event|unlisten') return Promise.resolve();
    if (cmd === 'load_data') {
      return Promise.resolve({ tasks: window.__TASKS__.map(t => ({ ...t })), projects: [{ id: 'local', name: '全局' }] });
    }
    if (cmd === 'set_window_size') return Promise.resolve();
    if (cmd === 'issue_detail') {
      const t = window.__TASKS__.find(t => t.id === args.id);
      if (!t) return Promise.reject({ code: 'TASK_NOT_FOUND' });
      return Promise.resolve({ task: { ...t }, comments: [], activities: [] });
    }
    return Promise.resolve({});
  },
  transformCallback: (cb) => { const id = ++window.__nextCbId; window.__CB__[id] = cb; return id; },
};
`;

const server = http.createServer((req, res) => {
  fs.readFile(path.join(ROOT, 'mini.html'), (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=400,600', 'about:blank',
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

  // ---- N-1 handler 注册 ----
  const registered = await evalJs(`!!window.__LISTENERS__['notification-click']`);
  check('N-1 notification-click 监听已注册（Rust emit 有消费方）', registered === true, `registered=${registered}`);

  // 起始态：mini 收起（#large display:none，e2e 契约：展开为 flex）
  const startMini = await evalJs(`document.getElementById('large') ? getComputedStyle(document.getElementById('large')).display : 'absent'`);

  // ---- N-2 收起态触发 → 展开 + 详情直达 ----
  await evalJs(`window.__LISTENERS__['notification-click']({ payload: { taskId: 'T-9' } }); 'fired'`);
  await sleep(600);
  const expanded = await evalJs(`(() => {
    const large = document.getElementById('large');
    const title = document.getElementById('dTitle');
    const ident = document.getElementById('dIdent');
    return {
      largeShown: !!large && getComputedStyle(large).display === 'flex',
      detailTitle: title ? title.textContent : null,
      detailIdent: ident ? ident.textContent : null,
    };
  })()`);
  check('N-2 触发后 #large 展开（mini none → flex）', startMini === 'none' && expanded.largeShown === true, `start=${startMini} now=${expanded.largeShown}`);
  check('N-2b 详情直达目标任务（#dTitle/#dIdent 契约）', expanded.detailTitle === '待评审的AI任务' && expanded.detailIdent === 'TSK-9', JSON.stringify(expanded));

  // ---- N-4 面板已展开时触发另一个任务：仅切详情 ----
  await evalJs(`window.__LISTENERS__['notification-click']({ payload: { taskId: 'T-8' } }); 'fired2'`);
  await sleep(600);
  const switched = await evalJs(`(() => { const t = document.getElementById('dTitle'); const i = document.getElementById('dIdent'); return t ? t.textContent : null; })()`);
  check('N-3 展开态再触发切到目标任务详情', switched === '普通任务', `dTitle=${switched}`);

  fs.writeFileSync(OUT, JSON.stringify({ results }, null, 2), 'utf8');
  console.log('---');
  console.log(`结果: ${results.filter(r => r.pass).length}/${results.length} 通过`);
  await send('Browser.close').catch(() => {});
  await sleep(1500);
  ws.close();
  server.close();
}

main().then(() => { setTimeout(() => process.exit(results.some(r => !r.pass) ? 2 : 0), 2500); })
  .catch((e) => { console.error('FATAL', e); server.close(); process.exit(1); });
