// P3 视觉断言：指示点 scaleX 方案渲染宽度 + font-xs 10.5px 生效
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';

const server = http.createServer((req, res) => {
  fs.readFile('D:/git/taskboard-skill/widget/dist/mini.html', (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

const MOCK_JS = `
window.__TAURI__ = {
  core: { invoke: (cmd) => Promise.resolve(cmd === 'load_data' ? { tasks: [
    { id: 'T-1', title: '任务一', identifier: 'TSK-1', status: 'todo', priority: 'none', dueDate: null, version: 1 },
    { id: 'T-2', title: '任务二', identifier: 'TSK-2', status: 'in_progress', priority: 'none', dueDate: null, version: 1 },
  ], projects: [{ id: 'local', name: '本地' }] } : {}) },
  event: { listen: () => Promise.resolve(() => {}) },
};
`;

const chrome = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--remote-debugging-port=8495', '--user-data-dir=D:/git/taskboard-skill/widget/tests/.out/hp-p3',
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  await new Promise(r => server.listen(8478, r));
  let v;
  for (let i = 0; i < 30 && !v; i++) { try { v = await fetch('http://127.0.0.1:8495/json/version').then(r => r.json()); } catch {} await sleep(500); }
  const target = await fetch('http://127.0.0.1:8495/json/new?http://localhost:8478/mini.html', { method: 'PUT' }).then(r => r.json());
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let msgId = 0; const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const evalJs = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result?.result?.value; };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: MOCK_JS });
  await send('Page.navigate', { url: 'http://localhost:8478/mini.html' });
  await sleep(1500);

  const r = await evalJs(`(() => {
    const on = document.querySelector('#miniDots i.on');
    const off = document.querySelector('#miniDots i:not(.on)');
    const dots = { onW: on ? on.getBoundingClientRect().width : null, offW: off ? off.getBoundingClientRect().width : null };
    document.getElementById('expandBtn').click();   // 量完 mini 再展开（display:none 时 rect 为 0）
    const countsLabel = document.querySelector('#counts .c .l');
    return { ...dots, labelFont: countsLabel ? getComputedStyle(countsLabel).fontSize : null };
  })()`);
  console.log('断言数据:', JSON.stringify(r));
  const pass1 = r.onW !== null && Math.round(r.onW) === 10 && r.offW !== null && Math.round(r.offW) === 3;
  console.log(pass1 ? 'PASS 指示点激活宽度 10px / 未激活 3px（scaleX 视觉等价）' : `FAIL 指示点宽度 on=${r.onW} off=${r.offW}`);
  const pass2 = r.labelFont === '10.5px';
  console.log(pass2 ? 'PASS font-xs 已生效 10.5px' : `FAIL font-xs: ${r.labelFont}`);

  await send('Browser.close').catch(() => {});
  await sleep(1500);
  server.close();
  process.exit(pass1 && pass2 ? 0 : 2);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
