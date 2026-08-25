// FB 详情面板实测：无头 Chrome + CDP 打开 fullboard.html，mock __TAURI_INTERNALS__。
// 验证点：
//   FB-D1 点卡片开详情（identifier/标题/评论数）
//   FB-D2 状态下拉流转 → update_task 收到 status + 活动流记录
//   FB-D3 标题编辑 → update_task 收到 title
//   FB-D4 描述 Markdown 渲染（GFM 表格/代码块）+ XSS 净化
//   FB-D5 发评论 → add_comment + 列表刷新
//   FB-D6 Esc 关闭详情
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/git/taskboard-skill/widget/dist';
const PORT = 8480;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEBUG_PORT = 8498;
const PROFILE = path.resolve('.out', 'profile-fbdetail');
const PAGE_URL = `http://localhost:${PORT}/fullboard.html`;
const OUT = path.resolve('.out', 'fb-detail-verify-result.json');

const MOCK_JS = `
// 颜色/对比度断言锁定暗色主题（防 headless Chrome 默认 prefers-light 触发亮色映射）
try { localStorage.setItem('taskboard-theme', 'dark'); } catch (e) {} // THEME-BOOT 内联脚本读到 dark（注入期 documentElement 可能为 null，勿在此直接设 className）

window.__UPDATES__ = [];
window.__COMMENTS__ = [];
window.__TASKS__ = [{
  id: 'T-2', title: '带描述的任务', identifier: 'TSK-2', status: 'todo', priority: 'high',
  dueDate: null, version: 1, sortOrder: 1000, createdAt: '2026-08-20T10:00:00.000Z',
  creatorType: 'user', creatorName: '本地用户',
  description: '# 标题\\n\\n| a | b |\\n|---|---|\\n| 1 | 2 |\\n\\n\`\`\`js\\ncode()\\n\`\`\`\\n\\n<script>alert(1)</script>',
  labels: [],
}];
window.__ACTIVITIES__ = [];
window.__TAURI_INTERNALS__ = {
  invoke(cmd, args) {
    if (cmd === 'plugin:event|listen') return Promise.resolve(1);
    if (cmd === 'plugin:event|unlisten') return Promise.resolve();
    if (cmd === 'load_data') {
      return Promise.resolve({ tasks: window.__TASKS__, projects: [{ id: 'local', name: '全局' }] });
    }
    if (cmd === 'issue_detail') {
      const t = window.__TASKS__.find(t => t.id === args.id);
      if (!t) return Promise.reject({ code: 'TASK_NOT_FOUND', message: 'gone' });
      return Promise.resolve({ task: { ...t }, comments: window.__COMMENTS__.map((c, i) => ({ id: 'C-' + i, ...c })), activities: window.__ACTIVITIES__ });
    }
    if (cmd === 'update_task') {
      window.__UPDATES__.push(args);
      const t = window.__TASKS__.find(t => t.id === args.id);
      if (!t) return Promise.reject({ code: 'TASK_NOT_FOUND', message: 'gone' });
      if (t.version !== args.version) return Promise.reject({ code: 'VERSION_CONFLICT', message: 'conflict' });
      Object.assign(t, args.changes);
      t.version += 1;
      window.__ACTIVITIES__.push({ actorType: 'user', actorName: '本地用户', changes: JSON.stringify(Object.entries(args.changes).map(([field, after]) => ({ field, before: 'old', after }))), createdAt: '2026-08-25T10:00:00.000Z' });
      return Promise.resolve({ ...t });
    }
    if (cmd === 'add_comment') {
      window.__COMMENTS__.push({ body: args.body, authorType: 'user', authorName: '本地用户', createdAt: '2026-08-25T10:01:00.000Z' });
      return Promise.resolve({ ok: true });
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

  // ---- FB-D1 点卡片开详情 ----
  await evalJs(`document.querySelector('[data-task-id="T-2"]').click(); 'ok'`);
  await sleep(600);
  const opened = await evalJs(`(() => ({
    shown: !!document.querySelector('.fb-detail'),
    id: document.querySelector('.d-id')?.textContent,
    title: document.querySelector('.d-title')?.textContent,
  }))()`);
  check('FB-D1a 点卡片打开详情抽屉', opened.shown === true, JSON.stringify(opened));
  check('FB-D1b identifier 与标题正确', opened.id === 'TSK-2' && opened.title === '带描述的任务', `id=${opened.id} title=${opened.title}`);

  // ---- FB-D4 Markdown 渲染 + XSS ----
  const md = await evalJs(`(() => ({
    h1: !!document.querySelector('.fb-md h1'),
    table: !!document.querySelector('.fb-md table'),
    code: !!document.querySelector('.fb-md pre code'),
    xssScript: !!document.querySelector('.fb-md script'),
  }))()`);
  check('FB-D4a Markdown 标题/表格/代码块渲染', md.h1 && md.table && md.code, JSON.stringify(md));
  check('FB-D4b 描述中的 <script> 不执行', md.xssScript === false, `script=${md.xssScript}`);

  // ---- FB-D2 状态流转 ----
  await evalJs(`(() => { const s = document.querySelector('.d-hd .d-status'); s.value = 'in_progress'; s.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`);
  await sleep(600);
  const statusUpdate = await evalJs(`window.__UPDATES__[0]`);
  check('FB-D2 状态流转 update_task 收到 status', statusUpdate?.changes?.status === 'in_progress', JSON.stringify(statusUpdate?.changes));
  const actShown = await evalJs(`document.querySelector('.d-act .what')?.textContent || ''`);
  check('FB-D2b 活动流显示变更记录', actShown.includes('状态'), `text="${actShown.slice(0, 40)}"`);

  // ---- FB-D3 标题编辑 ----
  await evalJs(`(() => { document.querySelector('.d-title').click(); return 'ok'; })()`);
  await sleep(300);
  const titleEdited = await evalJs(`(() => {
    const input = document.querySelector('.d-title-input');
    if (!input) return null;
    input.value = '改过的标题';
    input.dispatchEvent(new Keyboard_EVENT());
    return 'set';
  })()`.replace('KEYBOARD_EVENT', 'Event("keydown")'));
  // 用 keydown Enter 触发保存
  await evalJs(`(() => {
    const input = document.querySelector('.d-title-input');
    if (!input) return 'no-input';
    input.focus();
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    input.dispatchEvent(ev);
    return 'enter';
  })()`);
  await sleep(600);
  const titleUpdate = await evalJs(`window.__UPDATES__.find(u => u.changes && u.changes.title)`);
  check('FB-D3 标题编辑 update_task 收到 title', titleUpdate?.changes?.title === '改过的标题', JSON.stringify(titleUpdate?.changes));
  void titleEdited;

  // ---- FB-D5 发评论 ----
  await evalJs(`(() => {
    const input = document.querySelector('.d-composer input');
    input.value = '第一条评论 **加粗**';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return 'ok';
  })()`);
  await sleep(600);
  const commented = await evalJs(`(() => ({
    count: document.querySelectorAll('.d-c').length,
    bold: !!document.querySelector('.d-c .b strong'),
    text: document.querySelector('.d-c .b')?.textContent,
  }))()`);
  check('FB-D5a 评论发表并渲染', commented.count === 1, `count=${commented.count}`);
  check('FB-D5b 评论支持 Markdown（加粗）', commented.bold === true, `text=${commented.text}`);

  // ---- FB-D6 Esc 关闭 ----
  await evalJs(`document.body.focus(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); 'ok'`);
  await sleep(400);
  const closed = await evalJs(`document.querySelector('.fb-detail') === null`);
  check('FB-D6 Esc 关闭详情', closed === true, `closed=${closed}`);

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
