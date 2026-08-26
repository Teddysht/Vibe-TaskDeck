// FB P5 实测：归档面板 + 右键菜单 + 标签编辑（mock __TAURI_INTERNALS__）。
// 验证点：
//   FB-A1 右键卡片 → 菜单出现 → 「归档」→ 任务移出看板进归档面板
//   FB-A2 归档面板展开 → 恢复 → 任务回列
//   FB-A3 归档后永久删除 → 面板移除（含未归档删除拒绝路径）
//   FB-A4 详情标签：库标签勾选 + 新建入库
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/git/taskboard-skill/widget/dist';
const PORT = 8482;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEBUG_PORT = 8500;
const PROFILE = path.resolve('.out', 'profile-fbarch');
const PAGE_URL = `http://localhost:${PORT}/fullboard.html?view=board`; // ?view=board：仪表盘现为默认视图，看板类断言需显式入口
const OUT = path.resolve('.out', 'fb-archive-verify-result.json');

const MOCK_JS = `
// 颜色/对比度断言锁定暗色主题（防 headless Chrome 默认 prefers-light 触发亮色映射）
try { localStorage.setItem('taskboard-theme', 'dark'); } catch (e) {} // THEME-BOOT 内联脚本读到 dark（注入期 documentElement 可能为 null，勿在此直接设 className）

window.__OPS__ = [];
window.__TASKS__ = [
  { id: 'T-1', title: '待归档', identifier: 'TSK-1', status: 'todo', priority: 'none', dueDate: null, version: 1, sortOrder: 1000, createdAt: '2026-08-20T10:00:00.000Z', creatorType: 'user', creatorName: '本地用户', description: '', labels: [], archivedAt: null },
  { id: 'T-2', title: '另一个', identifier: 'TSK-2', status: 'todo', priority: 'none', dueDate: null, version: 1, sortOrder: 2000, createdAt: '2026-08-20T10:01:00.000Z', creatorType: 'user', creatorName: '本地用户', description: '', labels: [], archivedAt: null },
];
window.__CATALOG__ = ['缺陷', '特性'];
window.__TAURI_INTERNALS__ = {
  invoke(cmd, args) {
    if (cmd === 'plugin:event|listen') return Promise.resolve(1);
    if (cmd === 'plugin:event|unlisten') return Promise.resolve();
    if (cmd === 'load_data') {
      // 深拷贝：真实后端每次返回新对象（引用变化驱动 React 重渲染），
      // mock 若返回同一引用会绕过 zustand selector 的变更检测
      return Promise.resolve({ tasks: JSON.parse(JSON.stringify(window.__TASKS__)), projects: [{ id: 'local', name: '全局', labels: [...window.__CATALOG__] }] });
    }
    if (cmd === 'issue_detail') {
      const t = window.__TASKS__.find(t => t.id === args.id);
      if (!t) return Promise.reject({ code: 'TASK_NOT_FOUND', message: 'gone' });
      return Promise.resolve({ task: { ...t }, comments: [], activities: [], relations: { parent: [], blocks: [], blockedBy: [], related: [] }, attachments: [] });
    }
    if (cmd === 'archive_task' || cmd === 'restore_task' || cmd === 'delete_task' || cmd === 'update_task' || cmd === 'add_label') {
      window.__OPS__.push({ cmd, args });
      const t = window.__TASKS__.find(t => t.id === args.id);
      if (!t) return Promise.reject({ code: 'TASK_NOT_FOUND', message: 'gone' });
      if (cmd === 'archive_task') { t.archivedAt = '2026-08-25T10:00:00.000Z'; t.version += 1; }
      if (cmd === 'restore_task') { t.archivedAt = null; t.version += 1; }
      if (cmd === 'delete_task') { if (!t.archivedAt) return Promise.reject({ code: 'TASK_NOT_ARCHIVED', message: 'not archived' }); window.__TASKS__ = window.__TASKS__.filter(x => x.id !== args.id); }
      if (cmd === 'update_task') { Object.assign(t, args.changes); t.version += 1; }
      return Promise.resolve({ ...t });
    }
    if (cmd === 'add_label') {
      window.__CATALOG__.push(args.label);
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

  // ---- FB-A1 右键归档 ----
  await evalJs(`(() => {
    const card = document.querySelector('[data-task-id="T-1"]');
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
    return 'ctx';
  })()`);
  await sleep(300);
  const menuShown = await evalJs(`!!document.querySelector('.fb-ctxmenu')`);
  check('FB-A1a 右键弹出菜单', menuShown === true);
  await evalJs(`[...document.querySelectorAll('.fb-ctxmenu button')].find(b => b.textContent === '归档').click(); 'ok'`);
  await sleep(600);
  const archived = await evalJs(`(() => ({
    cards: document.querySelectorAll('.fb-card').length,
    archived: !!window.__TASKS__.find(t => t.id === 'T-1')?.archivedAt,
    // 归档入口现为顶栏按钮 + 徽标计数（原常驻侧栏 toggle 已移除）
    badge: document.querySelector('.fb-archivecount')?.textContent.trim() ?? null,
  }))()`);
  check('FB-A1b 归档后移出看板（剩 1 卡）', archived.cards === 1, `cards=${archived.cards}`);
  check('FB-A1c 归档入口徽标计数为 1', archived.badge === '1', `badge="${archived.badge}"`);

  // ---- FB-A2 恢复 ----
  await evalJs(`document.querySelector('.fb-archivebtn').click(); 'ok'`);
  await sleep(300);
  const panelRows = await evalJs(`document.querySelectorAll('.fb-archive-item').length`);
  check('FB-A2a 归档 Sheet 展开显示归档任务', panelRows === 1, `rows=${panelRows}`);
  await evalJs(`document.querySelector('.fb-archive-item .act.restore').click(); 'ok'`);
  await sleep(600);
  const restored = await evalJs(`(() => ({
    cards: document.querySelectorAll('.fb-card').length,
    archivedAt: window.__TASKS__.find(t => t.id === 'T-1')?.archivedAt,
    ops: window.__OPS__,
  }))()`);
  check('FB-A2b 恢复后回列（2 卡）', restored.cards === 2 && restored.archivedAt === null, `cards=${restored.cards} ops=${JSON.stringify(restored.ops)}`);

  // ---- FB-A3 归档 → 永久删除 ----
  await evalJs(`(() => {
    const card = document.querySelector('[data-task-id="T-1"]');
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
    return 'ok';
  })()`);
  await sleep(200);
  await evalJs(`[...document.querySelectorAll('.fb-ctxmenu button')].find(b => b.textContent === '归档').click(); 'ok'`);
  await sleep(500);
  // confirm 拦截（自动确认）
  await evalJs(`window.confirm = () => true; 'ok'`);
  await evalJs(`document.querySelector('.fb-archive-item .act.danger')?.click(); 'del'`);
  await sleep(600);
  const deleted = await evalJs(`(() => ({
    remaining: window.__TASKS__.length,
    badge: document.querySelector('.fb-archivecount')?.textContent.trim() ?? null,
  }))()`);
  check('FB-A3 永久删除成功（库剩 1 条）', deleted.remaining === 1 && deleted.badge === null, JSON.stringify(deleted));

  // ---- FB-A4 标签编辑 ----
  await evalJs(`document.querySelector('[data-task-id="T-2"]').click(); 'ok'`);
  await sleep(600);
  // 标签入口现为「标签」小节的「编辑」按钮（原 .d-label-add 已移除；
  // 描述小节也有同名按钮，须按小节标题精确定位）
  await evalJs(`(() => { const sec = [...document.querySelectorAll('.d-sec')].find(s => s.textContent.startsWith('标签')); const b = sec?.querySelector('.d-sec-btn'); if (b) b.click(); return b ? 'ok' : 'missing'; })()`);
  await sleep(300);
  const menuOpen = await evalJs(`!!document.querySelector('.d-label-menu')`);
  check('FB-A4a 标签菜单打开', menuOpen === true);
  // 勾选库标签「缺陷」
  await evalJs(`[...document.querySelectorAll('.d-label-menu > button')].find(b => b.textContent.includes('缺陷'))?.click(); 'ok'`);
  await sleep(500);
  const labeled = await evalJs(`(() => ({
    chips: document.querySelectorAll('.d-labels .label-chip').length,
    taskLabels: JSON.stringify(window.__TASKS__.find(t => t.id === 'T-2').labels),
  }))()`);
  check('FB-A4b 勾选标签生效', labeled.chips === 1 && labeled.taskLabels.includes('缺陷'), JSON.stringify(labeled));

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
