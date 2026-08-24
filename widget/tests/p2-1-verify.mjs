// P2-1 实测：头部图标带语义区分与防误触。
//   1. viewToggle 图标随布局切换（list 态=看板图标，board 态=列表图标，均显示目标视图）
//   2. board 态下 viewToggle（列表图标）与 boardBtn（外链图标）视觉可区分
//   3. closeBtn 有 margin 隔离 + hover 红色规则存在
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/git/taskboard-skill/widget/dist';
const PORT = 8475;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEBUG_PORT = 8485;
const PROFILE = path.resolve('.out', 'profile-p21');
const PAGE_URL = `http://localhost:${PORT}/mini.html`;
const OUT = path.resolve('.out', 'p2-1-verify-result.json');
const SHOT = path.resolve('.out', 'p2-1-shot-board.png');

const MOCK_JS = `
window.__TAURI__ = {
  core: {
    invoke(cmd) {
      if (cmd === 'load_data') return Promise.resolve({ tasks: [
        { id: 'T-2', title: '待办甲', identifier: 'TSK-2', status: 'todo', priority: 'none', dueDate: null, version: 1 },
      ], projects: [{ id: 'local', name: '本地' }] });
      return Promise.resolve({});
    },
  },
  event: { listen: () => Promise.resolve(() => {}) },
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
    return { title: v.title, hasRect: !!v.querySelector('rect'), hasPath: !!v.querySelector('path') };
  })()`);

  // list 态：显示目标视图 = 看板图标（rect 列）
  const s1 = await readToggle();
  check('P2-1a list 态 viewToggle 显示看板图标（rect）', s1.hasRect === true && s1.hasPath === false, JSON.stringify(s1));

  // 切到 board：显示列表图标（path 三横线），且与 boardBtn（path 外链）可通过形状区分
  await evalJs(`document.getElementById('viewToggle').click(); 'ok'`);
  await sleep(500);
  const s2 = await readToggle();
  check('P2-1b board 态 viewToggle 显示列表图标（path）', s2.hasRect === false && s2.hasPath === true, JSON.stringify(s2));
  check('P2-1c board 态 title 为「切换回列表视图」', s2.title === '切换回列表视图', `title="${s2.title}"`);

  // boardBtn 与 viewToggle 的图标 SVG 路径不同（语义可区分）
  const icons = await evalJs(`(() => {
    const a = document.getElementById('viewToggle').querySelector('svg').innerHTML;
    const b = document.getElementById('boardBtn').querySelector('svg').innerHTML;
    return { same: a === b };
  })()`);
  check('P2-1d board 态下 viewToggle 与 boardBtn 图标不同', icons.same === false, `same=${icons.same}`);

  // 再切回 list：图标恢复看板
  await evalJs(`document.getElementById('viewToggle').click(); 'ok'`);
  await sleep(500);
  const s3 = await readToggle();
  check('P2-1e 切回 list 态图标恢复看板（rect）', s3.hasRect === true && s3.hasPath === false, JSON.stringify(s3));

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
  check('P2-1h closeBtn title 含「关闭窗口」警示语', close.title.includes('关闭窗口'), `title="${close.title}"`);

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
