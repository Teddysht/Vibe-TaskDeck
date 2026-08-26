// P2-1 实测：头部图标带语义区分与防误触。
//   1. viewToggle 图标随布局切换（list 态=看板图标，board 态=列表图标，均显示目标视图）
//   2. board 态下 viewToggle（列表图标）与 boardBtn（外链图标）视觉可区分
//   3. closeBtn 有 margin 隔离 + hover 红色规则存在
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const PORT = 8475;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEBUG_PORT = 8485;
const PROFILE = path.resolve('.out', 'profile-p21');
const PAGE_URL = `http://localhost:${PORT}/mini.html`;
const OUT = path.resolve('.out', 'p2-1-verify-result.json');
const SHOT = path.resolve('.out', 'p2-1-shot-board.png');

const MOCK_JS = `
// 颜色/对比度断言锁定暗色主题（防 headless Chrome 默认 prefers-light 触发亮色映射）
try { localStorage.setItem('taskboard-theme', 'dark'); } catch (e) {} // THEME-BOOT 内联脚本读到 dark（注入期 documentElement 可能为 null，勿在此直接设 className）

window.__TAURI_INTERNALS__ = {
  invoke(cmd) {
    if (cmd === 'plugin:event|listen') return Promise.resolve(1);
    if (cmd === 'plugin:event|unlisten') return Promise.resolve();
    if (cmd === 'load_data') return Promise.resolve({ tasks: [
        { id: 'T-2', title: '待办甲', identifier: 'TSK-2', status: 'todo', priority: 'none', dueDate: null, version: 1 },
      ], projects: [{ id: 'local', name: '本地' }] });
    return Promise.resolve({});
  },
  transformCallback: () => 0,
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
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=480,720', 'about:blank',
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
  await sleep(1200);

  await evalJs(`document.getElementById('expandBtn').click(); 'ok'`);
  await sleep(600);

  const readToggle = () => evalJs(`(() => {
    const v = document.getElementById('viewToggle');
    return { title: v.title, hasRect: !!v.querySelector('rect'), hasPath: !!v.querySelector('path'), pathCount: v.querySelectorAll('path').length };
  })()`);

  // 快捷看板已移除：viewToggle 即全版看板入口（四角展开图标 = 4 条 path，无 rect）
  const s1 = await readToggle();
  check('P2-1a viewToggle 为全版看板入口（展开图标 path×4）', s1.hasRect === false && s1.pathCount === 4, JSON.stringify(s1));
  check('P2-1b viewToggle title 含「全版看板」', s1.title.includes('全版看板'), `title="${s1.title}"`);

  // 点击 → open_full_board 调用（mock 层返回成功 → toast「全版看板已打开」）
  await evalJs(`document.getElementById('viewToggle').click(); 'ok'`);
  await sleep(600);
  const opened = await evalJs(`(() => {
    const t = document.getElementById('toast');
    return { text: t ? t.textContent : '', show: t ? t.classList.contains('show') : false };
  })()`);
  check('P2-1c 点 viewToggle 触发 open_full_board → 成功 toast', opened.show === true && opened.text === '全版看板已打开', JSON.stringify(opened));

  // boardBtn 已移除（快捷看板删除后入口唯一化）
  const gone = await evalJs(`document.getElementById('boardBtn') === null`);
  check('P2-1d boardBtn 已移除（入口唯一）', gone === true, `boardBtn=${gone}`);

  // closeBtn：间距隔离 + hover 红色规则
  const close = await evalJs(`(() => {
    const el = document.getElementById('closeBtn');
    const ml = getComputedStyle(el).marginLeft;
    let hoverRule = false;
    for (const sheet of document.styleSheets) {
      try { for (const r of sheet.cssRules) { if (r.selectorText && r.selectorText.includes('.ic.close:hover')) hoverRule = true; } } catch {}
    }
    return { ml, hoverRule, title: el.title };
  })()`);
  check('P2-1f closeBtn 与收起键间距 6px', close.ml === '6px', `marginLeft=${close.ml}`);
  check('P2-1g closeBtn hover 红色警示规则存在', close.hoverRule === true);
  // fb70500 起 close 语义改为「隐藏挂件驻留托盘」（非直接关窗）——断言跟随产品
  check('P2-1h closeBtn title 说明隐藏驻留托盘语义', close.title.includes('隐藏挂件') && close.title.includes('托盘'), `title="${close.title}"`);

  // board 态截图（看板图标场景）
  await evalJs(`document.getElementById('viewToggle').click(); 'ok'`);
  await sleep(400);
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
