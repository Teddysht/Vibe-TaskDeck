// FB 动效实测：无头 Chrome + CDP 打开 fullboard.html，mock __TAURI_INTERNALS__。
// 验证点（对应动效审计三项修复）：
//   FB-M1 详情 Tab 下划线共享元素滑动（motion layoutId：位置随激活 Tab 平移）
//   FB-M2 三大视图切换 fb-view-in 淡入动画（仪表盘/看板/列表容器）
//   FB-M3 抽屉入场改 @starting-style + transition（可中断；退出仍 keyframes）
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/git/taskboard-skill/widget/dist';
const PORT = 8482;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEBUG_PORT = 8499;
const PROFILE = path.resolve('.out', 'profile-fbmotion');
const PAGE_URL = `http://localhost:${PORT}/fullboard.html`;
const OUT = path.resolve('.out', 'fb-motion-verify-result.json');

const MOCK_JS = `
try { localStorage.setItem('taskboard-theme', 'dark'); } catch (e) {}
window.__TASKS__ = [{
  id: 'T-1', title: '动效验证任务', identifier: 'TSK-1', status: 'todo', priority: 'high',
  dueDate: null, version: 1, sortOrder: 1000, createdAt: '2026-08-20T10:00:00.000Z',
  creatorType: 'user', creatorName: '本地用户', description: '# 描述', labels: [],
}];
window.__COMMENTS__ = [{ body: '占位评论', authorType: 'user', authorName: '本地用户', createdAt: '2026-08-25T10:01:00.000Z' }];
window.__TAURI_INTERNALS__ = {
  invoke(cmd, args) {
    if (cmd === 'plugin:event|listen') return Promise.resolve(1);
    if (cmd === 'plugin:event|unlisten') return Promise.resolve();
    if (cmd === 'load_data') {
      // 必须返回新数组/新对象引用：真实 Rust 每次返回新值；同引用会被
      // zustand selector 判等跳过重渲染（曾导致看板不挪列的假阴性）
      return Promise.resolve({ tasks: window.__TASKS__.map(t => ({ ...t })), projects: [{ id: 'local', name: '全局' }] });
    }
    if (cmd === 'issue_detail') {
      const t = window.__TASKS__.find(t => t.id === args.id);
      if (!t) return Promise.reject({ code: 'TASK_NOT_FOUND', message: 'gone' });
      return Promise.resolve({ task: { ...t }, comments: window.__COMMENTS__.map((c, i) => ({ id: 'C-' + i, ...c })), activities: [] });
    }
    if (cmd === 'update_task') {
      const t = window.__TASKS__.find(t => t.id === args.id);
      if (t) { Object.assign(t, args.changes); t.version += 1; }
      return Promise.resolve(t ? { ...t } : null);
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

  // ---- FB-M2 视图切换动画（默认仪表盘 → 看板 → 列表） ----
  const dashAnim = await evalJs(`getComputedStyle(document.querySelector('.fb-dash')).animationName`);
  check('FB-M2a 仪表盘容器挂 fb-view-in 动画', dashAnim === 'fb-view-in', `animationName=${dashAnim}`);

  await evalJs(`(() => { const btns = document.querySelectorAll('.fb-viewtoggle button'); btns[1].click(); return 'ok'; })()`);
  await sleep(300);
  const boardState = await evalJs(`(() => {
    const el = document.querySelector('.fb-board');
    if (!el) return { found: false };
    const cs = getComputedStyle(el);
    return { found: true, anim: cs.animationName, dur: cs.animationDuration };
  })()`);
  check('FB-M2b 切看板重挂载并播 fb-view-in', boardState.found && boardState.anim === 'fb-view-in', JSON.stringify(boardState));

  await evalJs(`(() => { const btns = document.querySelectorAll('.fb-viewtoggle button'); btns[2].click(); return 'ok'; })()`);
  await sleep(300);
  const listAnim = await evalJs(`getComputedStyle(document.querySelector('.fb-list')).animationName`);
  check('FB-M2c 切列表播 fb-view-in', listAnim === 'fb-view-in', `animationName=${listAnim}`);

  // ---- FB-M1 Tab 下划线共享元素滑动 ----
  await evalJs(`document.querySelector('[data-task-id="T-1"]').click(); 'ok'`);
  await sleep(500);
  const lineBefore = await evalJs(`(() => {
    const line = document.querySelector('.d-tab-line');
    const tabs = [...document.querySelectorAll('.d-tab')];
    if (!line || !tabs.length) return null;
    const lr = line.getBoundingClientRect();
    const tr = tabs[0].getBoundingClientRect();
    // 下划线刻意内缩 6px（.d-tab-line left/right:6px），对位断言带 inset
    const inset = 6, tol = 2;
    return { lx: lr.left, underFirst: Math.abs(lr.left - (tr.left + inset)) < tol && Math.abs(lr.right - (tr.right - inset)) < tol };
  })()`);
  check('FB-M1a 详情 Tab 激活时共享下划线存在且对位', !!lineBefore && lineBefore.underFirst === true, JSON.stringify(lineBefore));

  // 切到评论 Tab：同一根下划线（layoutId）平移到第二个 Tab 下方
  await evalJs(`(() => { const tabs = document.querySelectorAll('.d-tab'); tabs[1].click(); return 'ok'; })()`);
  await sleep(60); // 动画进行中：transform 应处于平移状态
  const midFlight = await evalJs(`(() => {
    const line = document.querySelector('.d-tab-line');
    if (!line) return null;
    const cs = getComputedStyle(line);
    const tr = new DOMMatrixReadOnly(cs.transform);
    return { hasTransform: tr.m41 !== 0 || tr.m42 !== 0 };
  })()`);
  await sleep(400); // 动画结束后：对位第二个 tab（此时 transform 应回到 ~0，位置由 left 承担）
  const lineAfter = await evalJs(`(() => {
    const line = document.querySelector('.d-tab-line');
    const tabs = [...document.querySelectorAll('.d-tab')];
    if (!line || !tabs[1]) return null;
    const lr = line.getBoundingClientRect();
    const tr = tabs[1].getBoundingClientRect();
    const inset = 6, tol = 2;
    return { lx: lr.left, underSecond: Math.abs(lr.left - (tr.left + inset)) < tol && Math.abs(lr.right - (tr.right - inset)) < tol };
  })()`);
  check('FB-M1b 切评论 Tab 下划线平移到第二 Tab 下', !!lineAfter && lineAfter.underSecond === true, JSON.stringify(lineAfter));
  check('FB-M1c 平移过程有 transform（motion layout 动画在跑）', !!midFlight && midFlight.hasTransform === true, JSON.stringify(midFlight));

  // ---- FB-M3 抽屉入场 @starting-style + transition ----
  const drawerCss = await evalJs(`(() => {
    const cs = getComputedStyle(document.querySelector('.fb-detail'));
    return { anim: cs.animationName, props: cs.transitionProperty, dur: cs.transitionDuration };
  })()`);
  check('FB-M3a 入场不再是 keyframes（animationName=none）', drawerCss.anim === 'none', JSON.stringify(drawerCss));
  check('FB-M3b transition 含 opacity+transform（可中断续走）', drawerCss.props.includes('opacity') && drawerCss.props.includes('transform'), `props=${drawerCss.props}`);

  // 关闭 → closing 120ms 内仍是 keyframes 退出（fb-panel-out）
  await evalJs(`(() => { document.querySelector('.d-close').click(); return 'ok'; })()`);
  await sleep(40);
  const closingCss = await evalJs(`(() => {
    const d = document.querySelector('.fb-detail');
    if (!d) return null;
    return { anim: getComputedStyle(d).animName || getComputedStyle(d).animationName, closing: d.classList.contains('closing') };
  })()`);
  check('FB-M3c 退出仍走 fb-panel-out keyframes', !!closingCss && closingCss.anim === 'fb-panel-out' && closingCss.closing === true, JSON.stringify(closingCss));

  // closing 中途重开：下划线/抽屉恢复，不再从零重启（transition 从定格处续回）
  await sleep(30); // 仍处 closing 窗口（120ms）内
  await evalJs(`document.querySelector('[data-task-id="T-1"]').click(); 'ok'`);
  await sleep(400);
  const reopened = await evalJs(`(() => {
    const d = document.querySelector('.fb-detail');
    if (!d) return null;
    const cs = getComputedStyle(d);
    return { closing: d.classList.contains('closing'), opacity: cs.opacity, anim: cs.animationName };
  })()`);
  check('FB-M3d closing 中途重开抽屉恢复显示（opacity 回 1）', !!reopened && reopened.closing === false && reopened.opacity === '1', JSON.stringify(reopened));

  // 入场过程抽查：重开抽屉瞬间 opacity 应 < 1（@starting-style 起跳生效）
  await evalJs(`(() => { document.querySelector('.d-close').click(); return 'ok'; })()`);
  await sleep(300);
  await evalJs(`document.querySelector('[data-task-id="T-1"]').click(); 'ok'`);
  await sleep(60);
  const entryOpacity = await evalJs(`(() => {
    const d = document.querySelector('.fb-detail');
    return d ? getComputedStyle(d).opacity : null;
  })()`);
  const entryOpNum = entryOpacity === null ? null : parseFloat(entryOpacity);
  check('FB-M3e 入场中 opacity < 1（@starting-style 起跳）', entryOpNum !== null && entryOpNum < 0.99, `opacity@60ms=${entryOpacity}`);

  // ---- FB-M4 看板卡片跨列 FLIP（motion layoutId 共享元素） ----
  await evalJs(`(() => { document.querySelector('.d-close').click(); return 'ok'; })()`);
  await sleep(300);
  await evalJs(`(() => { const btns = document.querySelectorAll('.fb-viewtoggle button'); btns[1].click(); return 'ok'; })()`);
  await sleep(300);
  const startCol = await evalJs(`(() => {
    const card = document.querySelector('[data-task-id="T-1"]');
    if (!card) return null;
    return card.closest('.fb-col')?.dataset.status ?? null;
  })()`);
  check('FB-M4a 起始卡片位于 todo 列', startCol === 'todo', `col=${startCol}`);

  await evalJs(`document.querySelector('[data-task-id="T-1"]').click(); 'ok'`);
  await sleep(500);
  // 状态流转前装好采样器：跨列瞬间 wrapper（card.parentElement）会被 motion
  // 打上平移 transform（FLIP 在跑的证据）
  await evalJs(`(() => {
    window.__FLIP__ = { seen: false, samples: 0 };
    const iv = setInterval(() => {
      const card = document.querySelector('[data-task-id="T-1"]');
      const wrap = card && card.parentElement;
      if (wrap) {
        window.__FLIP__.samples++;
        const tr = getComputedStyle(wrap).transform;
        if (tr && tr !== 'none') window.__FLIP__.seen = true;
      }
    }, 25);
    setTimeout(() => clearInterval(iv), 1200);
    return 'sampler-on';
  })()`);
  await evalJs(`document.querySelector('.d-status-trigger').click(); 'trigger-clicked'`);
  await sleep(200); // 等 React 把 popover 渲染进 DOM
  const optClicked = await evalJs(`(() => {
    const opts = [...document.querySelectorAll('.d-status-pop [role="option"]')];
    const done = opts.find(o => o.textContent.includes('已完成'));
    if (!done) return 'no-done-option';
    done.click();
    return 'clicked';
  })()`);
  check('FB-M4-pre 状态菜单「已完成」可点', optClicked === 'clicked', optClicked);
  await sleep(1500);
  const flipResult = await evalJs(`(() => {
    const card = document.querySelector('[data-task-id="T-1"]');
    return {
      seen: window.__FLIP__?.seen === true,
      samples: window.__FLIP__?.samples ?? 0,
      col: card ? card.closest('.fb-col')?.dataset.status : null,
    };
  })()`);
  check('FB-M4b 状态流转后卡片位于 done 列', flipResult.col === 'done', `col=${flipResult.col}`);
  check('FB-M4c 跨列过程 wrapper 有平移 transform（FLIP 动画在跑）', flipResult.seen === true && flipResult.samples > 0, JSON.stringify(flipResult));

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
