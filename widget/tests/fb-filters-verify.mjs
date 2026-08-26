// FB 筛选/搜索/键盘/列表视图/undo 实测（mock __TAURI_INTERNALS__）。
// 验证点：
//   FB-F1 关键词搜索过滤卡片 + URL 同步
//   FB-F2 状态/优先级筛选生效 + 清除
//   FB-F3 切列表视图（?view=list URL 同步 + 行渲染）
//   FB-F4 "/" 聚焦搜索、Ctrl+Z 撤销流转（toast + 状态回滚）
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const PORT = 8481;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEBUG_PORT = 8499;
const PROFILE = path.resolve('.out', 'profile-fbfilter');
const PAGE_URL = `http://localhost:${PORT}/fullboard.html?view=board`; // ?view=board：仪表盘现为默认视图，看板类断言需显式入口
const OUT = path.resolve('.out', 'fb-filters-verify-result.json');

const MOCK_JS = `
// 颜色/对比度断言锁定暗色主题（防 headless Chrome 默认 prefers-light 触发亮色映射）
try { localStorage.setItem('taskboard-theme', 'dark'); } catch (e) {} // THEME-BOOT 内联脚本读到 dark（注入期 documentElement 可能为 null，勿在此直接设 className）

window.__MOVES__ = [];
window.__TASKS__ = [
  { id: 'T-1', title: '修复登录Bug', identifier: 'TSK-1', status: 'todo', priority: 'urgent', dueDate: null, version: 1, sortOrder: 1000, createdAt: '2026-08-20T10:00:00.000Z', creatorType: 'user', creatorName: '本地用户', description: '', labels: ['缺陷'] },
  { id: 'T-2', title: '新增导出功能', identifier: 'TSK-2', status: 'in_progress', priority: 'high', dueDate: null, version: 1, sortOrder: 1000, createdAt: '2026-08-20T10:01:00.000Z', creatorType: 'agent', creatorName: 'Codex Agent', description: '', labels: ['特性'] },
  { id: 'T-3', title: '登录页样式调整', identifier: 'TSK-3', status: 'todo', priority: 'low', dueDate: null, version: 1, sortOrder: 2000, createdAt: '2026-08-20T10:02:00.000Z', creatorType: 'user', creatorName: '本地用户', description: '', labels: [] },
];
window.__TAURI_INTERNALS__ = {
  invoke(cmd, args) {
    if (cmd === 'plugin:event|listen') return Promise.resolve(1);
    if (cmd === 'plugin:event|unlisten') return Promise.resolve();
    if (cmd === 'load_data') {
      return Promise.resolve({ tasks: window.__TASKS__, projects: [{ id: 'local', name: '全局', labels: ['缺陷', '特性'] }] });
    }
    if (cmd === 'move_task') {
      window.__MOVES__.push(args);
      const t = window.__TASKS__.find(t => t.id === args.id);
      if (!t) return Promise.reject({ code: 'TASK_NOT_FOUND', message: 'gone' });
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

  // ---- FB-F1 关键词搜索 ----（React 受控输入需原生 value setter 绕过值追踪器）
  await evalJs(`(() => {
    const i = document.getElementById('fb-search');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(i, '登录');
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`);
  await sleep(400);
  const searched = await evalJs(`(() => ({
    cards: document.querySelectorAll('.fb-card').length,
    url: location.search,
  }))()`);
  check('FB-F1a 搜索「登录」只剩 2 张卡', searched.cards === 2, `cards=${searched.cards}`);
  check('FB-F1b URL 同步 content 参数', searched.url.includes('content='), `url=${searched.url}`);

  // 清空搜索
  await evalJs(`(() => {
    const i = document.getElementById('fb-search');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(i, '');
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`);
  await sleep(300);

  // ---- FB-F2 筛选收纳下拉（方案 A） ----
  // 默认态：筛选栏不铺平芯片，只有搜索框 + 筛选触发器
  const defaultBar = await evalJs(`(() => ({
    barChips: document.querySelectorAll('.fb-filterbar > .fb-chip').length,
    filterBtn: !!document.getElementById('fb-filter-btn'),
  }))()`);
  check('FB-F2a 默认态无铺平芯片，仅筛选触发器', defaultBar.barChips === 0 && defaultBar.filterBtn === true, JSON.stringify(defaultBar));

  // 打开下拉面板 → 选「紧急」优先级
  await evalJs(`document.getElementById('fb-filter-btn').click(); 'ok'`);
  await sleep(300);
  const menuOpen = await evalJs(`(() => ({
    open: !!document.querySelector('.fb-filtermenu'),
    groups: [...document.querySelectorAll('.fb-fgtitle')].map(g => g.textContent),
    labelChips: document.querySelectorAll('.fb-filtermenu .fb-flabels .fb-chip').length,
  }))()`);
  check('FB-F2b 面板开：状态/优先级/标签三组', menuOpen.open && menuOpen.groups.join(',') === '状态,优先级,标签', JSON.stringify(menuOpen));
  check('FB-F2c 标签组全量收纳（不 slice 8 个）', menuOpen.labelChips === 2, `labelChips=${menuOpen.labelChips}`);

  await evalJs(`[...document.querySelectorAll('.fb-filtermenu .fb-chip')].find(c => c.textContent === '紧急').click(); 'ok'`);
  await sleep(400);
  const priFiltered = await evalJs(`(() => ({
    cards: document.querySelectorAll('.fb-card').length,
    url: location.search,
    badge: document.querySelector('.fb-filtercount')?.textContent,
    activeChip: document.querySelector('.fb-filterbar > .fb-activechip')?.textContent,
  }))()`);
  check('FB-F2d 优先级 urgent 筛选只剩 1 张', priFiltered.cards === 1, `cards=${priFiltered.cards}`);
  check('FB-F2e URL 同步 priority 参数', priFiltered.url.includes('priority=urgent'), `url=${priFiltered.url}`);
  check('FB-F2f 触发器计数徽标 = 1', priFiltered.badge === '1', `badge=${priFiltered.badge}`);
  check('FB-F2g 已激活条件显示为可删胶囊', (priFiltered.activeChip || '').includes('紧急'), `chip=${priFiltered.activeChip}`);

  // 可删胶囊：点 × 移除单个条件
  await evalJs(`document.querySelector('.fb-filterbar > .fb-activechip')?.click(); 'ok'`);
  await sleep(300);
  const removed = await evalJs(`(() => ({
    cards: document.querySelectorAll('.fb-card').length,
    badge: !!document.querySelector('.fb-filtercount'),
  }))()`);
  check('FB-F2h 可删胶囊移除单个条件', removed.cards === 3 && removed.badge === false, JSON.stringify(removed));

  // 面板内再选一个 → 清除全部（含搜索词）。注：点可删胶囊（面板外）已触发外点关闭，需重开
  await evalJs(`document.getElementById('fb-filter-btn').click(); 'ok'`);
  await sleep(250);
  await evalJs(`[...document.querySelectorAll('.fb-filtermenu .fb-chip')].find(c => c.textContent === '紧急').click(); 'ok'`);
  await sleep(300);
  await evalJs(`document.querySelector('.fb-filtermenu .fb-clear')?.click(); 'ok'`);
  await sleep(300);
  const cleared = await evalJs(`(() => ({
    cards: document.querySelectorAll('.fb-card').length,
    badge: !!document.querySelector('.fb-filtercount'),
  }))()`);
  check('FB-F2i 清除全部恢复 3 张且徽标消失', cleared.cards === 3 && cleared.badge === false, JSON.stringify(cleared));

  // 面板外点关闭
  await evalJs(`document.querySelector('.fb-board').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); 'ok'`);
  await sleep(250);
  const menuClosed = await evalJs(`!document.querySelector('.fb-filtermenu')`);
  check('FB-F2j 面板外点关闭', menuClosed === true);

  // ---- FB-F2k 状态筛选=看板只留所选列（新语义：列即状态） ----
  await evalJs(`document.getElementById('fb-filter-btn').click(); 'ok'`);
  await sleep(250);
  await evalJs(`[...document.querySelectorAll('.fb-filtermenu .fb-chip')].find(c => c.textContent === '待处理').click(); 'ok'`);
  await sleep(400);
  const statusFiltered = await evalJs(`(() => ({
    cols: document.querySelectorAll('.fb-col').length,
    cards: document.querySelectorAll('.fb-card').length,
  }))()`);
  check('FB-F2k 状态筛选只留所选列（todo 列 2 卡）', statusFiltered.cols === 1 && statusFiltered.cards === 2, JSON.stringify(statusFiltered));
  // 清除，避免影响后续
  await evalJs(`document.querySelector('.fb-filtermenu .fb-clear')?.click(); 'ok'`);
  await sleep(300);

  // ---- FB-F3 列表视图 ----
  await evalJs(`[...document.querySelectorAll('.fb-viewtoggle button')].find(b => b.textContent === '列表').click(); 'ok'`);
  await sleep(400);
  const listView = await evalJs(`(() => ({
    rows: document.querySelectorAll('.fb-list-row').length,
    url: location.search,
    agBadge: !!document.querySelector('.fb-list-row .ag'),
  }))()`);
  check('FB-F3a 列表视图渲染 3 行', listView.rows === 3, `rows=${listView.rows}`);
  check('FB-F3b ?view=list URL 同步', listView.url.includes('view=list'), `url=${listView.url}`);
  check('FB-F3c 列表 agent 徽标', listView.agBadge === true);

  // FB-F3d 列表视图筛选生效（新语义：filteredTasks 全量过滤）——搜索「登录」只剩 2 行
  await evalJs(`(() => {
    const i = document.getElementById('fb-search');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(i, '登录');
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`);
  await sleep(400);
  const listFiltered = await evalJs(`document.querySelectorAll('.fb-list-row').length`);
  check('FB-F3d 列表视图搜索过滤 3→2 行', listFiltered === 2, `rows=${listFiltered}`);
  await evalJs(`(() => {
    const i = document.getElementById('fb-search');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(i, '');
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`);
  await sleep(300);
  // 切回看板
  await evalJs(`[...document.querySelectorAll('.fb-viewtoggle button')].find(b => b.textContent === '看板').click(); 'ok'`);
  await sleep(300);

  // ---- FB-F4a "/" 聚焦搜索 ----
  await evalJs(`document.body.focus(); document.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true })); 'ok'`);
  await sleep(200);
  const focused = await evalJs(`document.activeElement?.id`);
  check('FB-F4a "/" 聚焦搜索框', focused === 'fb-search', `focused=${focused}`);
  await evalJs(`document.activeElement.blur(); 'ok'`);

  // ---- FB-F4b Ctrl+Z 撤销流转 ----
  // 先做一次流转：T-1 拖到 in_progress 列（drop 事件）
  await evalJs(`(async () => {
    const col = document.querySelector('.fb-col[data-status="in_progress"]');
    const dt = new DataTransfer();
    dt.setData('application/x-taskboard-task', 'T-1');
    col.dispatchEvent(new DragEvent('dragenter', { bubbles: true }));
    col.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    col.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await new Promise(r => setTimeout(r, 400));
    return window.__TASKS__.find(t => t.id === 'T-1').status;
  })()`).then((s) => {
    check('FB-F4b-1 流转 T-1 → in_progress', s === 'in_progress', `status=${s}`);
  });
  // Ctrl+Z 撤销
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })); 'ok'`);
  await sleep(600);
  const undone = await evalJs(`(() => ({
    status: window.__TASKS__.find(t => t.id === 'T-1').status,
    moves: window.__MOVES__.length,
    toast: document.getElementById('toast') ? document.getElementById('toast').textContent : '',
  }))()`);
  check('FB-F4b-2 Ctrl+Z 撤销回 todo', undone.status === 'todo', `status=${undone.status}`);
  check('FB-F4b-3 撤销 toast 提示', undone.toast.includes('撤销'), `toast="${undone.toast}"`);

  fs.writeFileSync(OUT, JSON.stringify({ results }, null, 2), 'utf8');
  console.log('---');
  console.log(`结果: ${results.filter(r => r.pass).length}/${results.length} 通过`);
  await send('Browser.close').catch(() => {});
  await sleep(1500);
  ws.close();
  server.close();
  chrome.kill(); // 兜底：Browser.close 失败时防 chrome 残留占调试口/profile（下次同 profile 拉起会被单实例转发静默废掉）
}

main().then(() => { setTimeout(() => { try { chrome.kill(); } catch {} ; process.exit(results.some(r => !r.pass) ? 2 : 0); }, 2500); })
  .catch((e) => { console.error('FATAL', e); server.close(); try { chrome.kill(); } catch {}; process.exit(1); });
