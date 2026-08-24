// P2-3 实测：弱文字对比度 + 键盘可达性。
//   1. --text-weak 对 --bg-surface / --bg-surface-2 对比度 ≥ 4.5:1（WCAG AA 小字）
//   2. 静态与动态渲染的可交互元素均有 role=button + tabindex=0
//   3. 真实 Tab 键（trusted CDP 事件）能聚焦交互元素且 :focus-visible 焦点环生效
//   4. 聚焦 counts chip 后 Enter 触发筛选切换
//   5. 原生 button 上 Enter 不误触外层条目（进详情）
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/git/taskboard-skill/widget/dist';
const PORT = 8476;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEBUG_PORT = 8486;
const PROFILE = path.resolve('.out', 'profile-p23');
const PAGE_URL = `http://localhost:${PORT}/mini.html`;
const OUT = path.resolve('.out', 'p2-3-verify-result.json');

const MOCK_JS = `
window.__TAURI__ = {
  core: {
    invoke(cmd) {
      if (cmd === 'load_data') return Promise.resolve({ tasks: [
        { id: 'T-2', title: '待办甲', identifier: 'TSK-2', status: 'todo', priority: 'none', dueDate: null, version: 1 },
      ], projects: [{ id: 'local', name: '本地' }] });
      if (cmd === 'move_task') return Promise.resolve({ ok: true });
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
  const pressKey = (key, code, vk) => send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
    .then(() => send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }));

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: MOCK_JS });
  await send('Page.navigate', { url: PAGE_URL });
  await sleep(1200);

  // ---- 对比度 ----
  const contrast = await evalJs(`(() => {
    const lum = (rgb) => {
      const [r, g, b] = rgb.match(/\\d+/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const c = (fg, bg) => { const l1 = lum(fg), l2 = lum(bg); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
    const el = document.createElement('div');
    el.style.cssText = 'color:var(--text-weak)';
    document.body.appendChild(el);
    const weak = getComputedStyle(el).color;
    const mk = (bg) => { el.style.cssText = 'background:' + bg; return getComputedStyle(el).backgroundColor; };
    const r = {
      weak,
      onSurface: c(weak, mk('var(--bg-surface)')),
      onSurface2: c(weak, mk('var(--bg-surface-2)')),
    };
    el.remove();
    return r;
  })()`);
  check('P2-3a --text-weak on --bg-surface ≥ 4.5:1', contrast.onSurface >= 4.5, `${contrast.weak} 对比 ${contrast.onSurface.toFixed(2)}:1`);
  check('P2-3b --text-weak on --bg-surface-2 ≥ 4.5:1', contrast.onSurface2 >= 4.5, `对比 ${contrast.onSurface2.toFixed(2)}:1`);

  // ---- 键盘语义 ----
  await evalJs(`document.getElementById('expandBtn').click(); 'ok'`);
  await sleep(600);
  const roles = await evalJs(`(() => {
    const ids = ['expandBtn', 'viewToggle', 'boardBtn', 'collapseBtn', 'closeBtn'];
    const bad = ids.filter(id => { const el = document.getElementById(id); return !el || el.getAttribute('role') !== 'button' || el.tabIndex !== 0; });
    const chip = document.querySelector('#counts .c[data-s="todo"]');
    const item = document.querySelector('#list .item');
    return {
      badStatic: bad,
      chipOk: !!chip && chip.getAttribute('role') === 'button' && chip.tabIndex === 0,
      itemOk: !!item && item.getAttribute('role') === 'button' && item.tabIndex === 0,
    };
  })()`);
  check('P2-3c 静态交互元素（头部五键）均有 role+tabindex', roles.badStatic.length === 0, badJoin(roles.badStatic));
  check('P2-3d 动态渲染（counts chip / 列表条目）有 role+tabindex', roles.chipOk === true && roles.itemOk === true, `chip=${roles.chipOk} item=${roles.itemOk}`);

  // ---- 真实 Tab 聚焦 + 焦点环 ----
  await evalJs(`document.getElementById('viewToggle').focus(); 'focused'`);
  const focusInfo = await evalJs(`(() => {
    const el = document.activeElement;
    const cs = getComputedStyle(el);
    return { id: el.id, outlineStyle: cs.outlineStyle, outlineColor: cs.outlineColor };
  })()`);
  // el.focus() 程序聚焦后 Chromium 未必给 :focus-visible，用真实 Tab 再验证
  await evalJs(`document.body.focus(); 'ok'`);
  let tabFocused = null;
  for (let i = 0; i < 6; i++){
    await pressKey('Tab', 'Tab', 9);
    await sleep(80);
    tabFocused = await evalJs(`(() => {
      const el = document.activeElement;
      if (!el || !el.matches('[role="button"],button')) return null;
      const cs = getComputedStyle(el);
      return { id: el.id || el.className, outlineStyle: cs.outlineStyle };
    })()`);
    if (tabFocused) break;
  }
  check('P2-3e Tab 键能聚焦到交互元素', !!tabFocused, tabFocused ? `聚焦 ${tabFocused.id}` : '6 次 Tab 未落到交互元素');
  check('P2-3f 键盘聚焦时 :focus-visible 焦点环生效', !!tabFocused && tabFocused.outlineStyle !== 'none', tabFocused ? `outline=${tabFocused.outlineStyle}（程序聚焦参考 ${focusInfo.outlineStyle}）` : '无聚焦');

  // ---- Enter 触发筛选切换 ----
  await evalJs(`document.querySelector('#counts .c[data-s="todo"]').focus(); 'ok'`);
  await pressKey('Enter', 'Enter', 13);
  await sleep(400);
  const filterState = await evalJs(`(() => ({
    todoOn: document.querySelector('#counts .c[data-s="todo"]').classList.contains('on'),
    items: document.querySelectorAll('#list .item').length,
  }))()`);
  check('P2-3g 聚焦 todo chip + Enter 触发筛选', filterState.todoOn === true && filterState.items === 1, `on=${filterState.todoOn} items=${filterState.items}`);

  // ---- 原生 button Enter 不误触外层条目 ----
  await evalJs(`document.querySelector('#counts .c[data-s="all"]').click(); 'ok'`);
  await sleep(300);
  await evalJs(`document.querySelector('#list .item button[data-a="in_progress"]').focus(); 'ok'`);
  await pressKey('Enter', 'Enter', 13);
  await sleep(600);
  const noMisfire = await evalJs(`(() => ({
    detailOpen: document.getElementById('detail').style.display === 'flex',
    // mock move_task 成功后 loadData 重渲染：todo 条目消失（状态已是 in_progress）
    todoItems: [...document.querySelectorAll('#list .item')].filter(i => i.dataset.id === 'T-2').length,
  }))()`);
  check('P2-3h button 上 Enter 只触发按钮本身（不误进详情）', noMisfire.detailOpen === false, `detailOpen=${noMisfire.detailOpen}`);

  fs.writeFileSync(OUT, JSON.stringify({ results, contrast }, null, 2), 'utf8');
  console.log('---');
  console.log(`结果: ${results.filter(r => r.pass).length}/${results.length} 通过`);
  await send('Browser.close').catch(() => {});
  await sleep(1500);
  ws.close();
  server.close();
}

function badJoin(arr){ return arr.length ? '缺失: ' + arr.join(',') : '全部就绪'; }

main().then(() => { setTimeout(() => process.exit(results.some(r => !r.pass) ? 2 : 0), 2500); })
  .catch((e) => { console.error('FATAL', e); server.close(); process.exit(1); });
