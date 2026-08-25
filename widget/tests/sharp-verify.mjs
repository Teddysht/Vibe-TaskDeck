// 尖锐问题 1+2 实测：agent 徽标前置 L1/L2 + 胶囊可点展开。
//   A. agent 任务在 L2 列表 / L2 看板卡片 / L1 mini 胶囊均有 AI 徽标；user 任务无
//   B. 徽标样式生效（accent-soft 底色）
//   C. mini meta 转义防注入（identifier 含 <script> 不执行）
//   D. 点胶囊 body 展开 large；点指示点不展开（只跳转）
//   E. 胶囊 role=button + Enter 键盘展开
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/git/Vibe-TaskDeck/widget/dist';
const PORT = 8477;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEBUG_PORT = 8487;
const PROFILE = path.resolve('.out', 'profile-sharp');
const PAGE_URL = `http://localhost:${PORT}/mini.html`;
const OUT = path.resolve('.out', 'sharp-verify-result.json');
const SHOT_L2 = path.resolve('.out', 'sharp-shot-list.png');

const MOCK_JS = `
// 颜色/对比度断言锁定暗色主题（防 headless Chrome 默认 prefers-light 触发亮色映射）
try { localStorage.setItem('taskboard-theme', 'dark'); } catch (e) {} // THEME-BOOT 内联脚本读到 dark（注入期 documentElement 可能为 null，勿在此直接设 className）

window.__TAURI_INTERNALS__ = {
  invoke(cmd) {
    if (cmd === 'plugin:event|listen') return Promise.resolve(1);
    if (cmd === 'plugin:event|unlisten') return Promise.resolve();
    if (cmd === 'load_data') return Promise.resolve({ tasks: [
        { id: 'A-1', title: 'AI 建的待办', identifier: 'TSK-101', status: 'todo', priority: 'none', dueDate: null, version: 1, creatorType: 'agent', threadId: 'th-1' },
        { id: 'U-1', title: '我建的待办', identifier: 'TSK-102', status: 'todo', priority: 'none', dueDate: null, version: 1, creatorType: 'user' },
        { id: 'A-2', title: 'AI 建的进行中 <img src=x onerror=window.__XSS__=1>', identifier: 'TSK-103<script>alert(1)</script>', status: 'in_progress', priority: 'none', dueDate: null, version: 1, creatorType: 'agent' },
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
  await sleep(1500);

  // ---- A1: L1 mini 胶囊徽标（轮转序列首位是 A-1，agent） ----
  const mini1 = await evalJs(`(() => ({
    hasAg: !!document.querySelector('#miniMeta .ag'),
    agText: (document.querySelector('#miniMeta .ag') || {}).textContent,
    metaText: document.getElementById('miniMeta').textContent,
  }))()`);
  check('A1 mini 胶囊 meta 行有 AI 徽标（agent 任务）', mini1.hasAg === true && mini1.agText === 'AI', JSON.stringify(mini1));

  // ---- C: 转义防注入（轮转到 A-2，identifier 含 script 标签） ----
  await evalJs(`__widgetStore.setState({ idx: 2 }); 'ok'`);
  await sleep(200);
  const xss = await evalJs(`(() => ({
    xssHit: window.__XSS__ === 1,
    metaHasScriptTag: !!document.querySelector('#miniMeta script'),
    metaText: document.getElementById('miniMeta').textContent,
  }))()`);
  check('C1 identifier 含 <script> 被转义不执行', xss.xssHit === false && xss.metaHasScriptTag === false, `xss=${xss.xssHit} scriptTag=${xss.metaHasScriptTag}`);
  check('C2 恶意 identifier 以文本呈现', xss.metaText.includes('TSK-103<script>') === true, `meta="${xss.metaText.slice(0, 60)}"`);

  // ---- E: 胶囊 role=button + Enter 展开 ----
  const roleOk = await evalJs(`(() => {
    const m = document.getElementById('mini');
    return { role: m.getAttribute('role'), tabIndex: m.tabIndex };
  })()`);
  check('E1 胶囊有 role=button + tabindex', roleOk.role === 'button' && roleOk.tabIndex === 0, JSON.stringify(roleOk));
  await evalJs(`document.getElementById('mini').focus(); 'ok'`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await sleep(500);
  const expandByKey = await evalJs(`document.getElementById('large').style.display`);
  check('E2 胶囊聚焦 + Enter 展开 large', expandByKey === 'flex', `large display=${expandByKey}`);
  // 收起，准备点击测试
  await evalJs(`document.getElementById('collapseBtn').click(); 'ok'`);
  await sleep(400);

  // ---- D1: 点胶囊 body 展开 ----
  await evalJs(`document.getElementById('miniBody').click(); 'ok'`);
  await sleep(400);
  const expandByClick = await evalJs(`document.getElementById('large').style.display`);
  check('D1 点胶囊内容区展开 large', expandByClick === 'flex', `display=${expandByClick}`);

  // ---- A2/A3: L2 列表徽标 ----
  await sleep(400);
  const list = await evalJs(`(() => ({
    agentItem: !!document.querySelector('#list .item[data-id="A-1"] .m .ag'),
    userItem: !!document.querySelector('#list .item[data-id="U-1"] .m .ag'),
    agCount: document.querySelectorAll('#list .item .ag').length,
    bg: (document.querySelector('#list .item[data-id="A-1"] .ag') || {}).textContent,
  }))()`);
  check('A2 L2 列表 agent 任务有徽标 / user 任务无', list.agentItem === true && list.userItem === false, `agCount=${list.agCount}`);

  // ---- B: 徽标样式生效 ----
  const style = await evalJs(`(() => {
    const el = document.querySelector('#list .item[data-id="A-1"] .ag');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { color: cs.color, bg: cs.backgroundColor };
  })()`);
  const accentOk = style && style.color === 'rgb(143, 162, 255)' && style.bg.includes('110, 139, 255');
  check('B1 徽标 accent 色系生效（与 L3 同源）', accentOk === true, style ? `color=${style.color} bg=${style.bg}` : '无元素');

  // 截图（列表态徽标）
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(SHOT_L2, Buffer.from(shot.result.data, 'base64'));

  // （原 A4 看板卡片徽标断言随快捷看板移除而删除——看板场景由全版第二窗口承担，
  //  其 agent 徽标由 upstream 侧渲染，agent-real 覆盖真实链路）

  fs.writeFileSync(OUT, JSON.stringify({ results }, null, 2), 'utf8');
  console.log('---');
  console.log(`结果: ${results.filter(r => r.pass).length}/${results.length} 通过；截图: ${SHOT_L2}`);
  await send('Browser.close').catch(() => {});
  await sleep(1500);
  ws.close();
  server.close();
}

main().then(() => { setTimeout(() => process.exit(results.some(r => !r.pass) ? 2 : 0), 2500); })
  .catch((e) => { console.error('FATAL', e); server.close(); process.exit(1); });
