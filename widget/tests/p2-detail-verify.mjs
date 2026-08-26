// P2-2 实测：详情页流转按钮。有状态 mock（move 成功改状态 version+1，
// version 不匹配返回 VERSION_CONFLICT），驱动真实 DOM 验证：
//   1. 详情动作条按状态渲染（共享 boardActions 协议）
//   2. 点流转 → 徽章与动作条即时更新
//   3. done 后动作条消失
//   4. 列表 blocked 文案回归「解除阻塞」（协议收敛后三视图一致）
//   5. 冲突重试路径：版本过期 → 重读 → 二次成功
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const PORT = 8474;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEBUG_PORT = 8484;
const PROFILE = path.resolve('.out', 'profile-p2');
const PAGE_URL = `http://localhost:${PORT}/mini.html`;
const OUT = path.resolve('.out', 'p2-detail-verify-result.json');
const SHOT = path.resolve('.out', 'p2-shot-detail.png');

const MOCK_JS = `
// 颜色/对比度断言锁定暗色主题（防 headless Chrome 默认 prefers-light 触发亮色映射）
try { localStorage.setItem('taskboard-theme', 'dark'); } catch (e) {} // THEME-BOOT 内联脚本读到 dark（注入期 documentElement 可能为 null，勿在此直接设 className）

window.__MOCK__ = { tasks: [
  { id: 'T-2', title: '待办甲', identifier: 'TSK-2', status: 'todo',        priority: 'high', dueDate: null, labels: ['设计'], version: 1 },
  { id: 'T-4', title: '进行中项', identifier: 'TSK-4', status: 'in_progress', priority: 'none', dueDate: null, version: 1 },
  { id: 'T-6', title: '被阻塞项', identifier: 'TSK-6', status: 'blocked',    priority: 'none', dueDate: null, version: 1 },
  { id: 'T-7', title: '已完成项', identifier: 'TSK-7', status: 'done',       priority: 'none', dueDate: null, version: 1 },
], projects: [{ id: 'local', name: '本地', labels: ['设计', '紧急修复'] }] };
window.__TAURI_INTERNALS__ = {
  invoke(cmd, args) {
    if (cmd === 'plugin:event|listen') return Promise.resolve(1);
    if (cmd === 'plugin:event|unlisten') return Promise.resolve();
    if (cmd === 'load_data') return Promise.resolve({ tasks: window.__MOCK__.tasks, projects: window.__MOCK__.projects });
    if (cmd === 'issue_detail') {
      const t = window.__MOCK__.tasks.find(t => t.id === args.id);
      if (!t) return Promise.reject({ code: 'TASK_NOT_FOUND', message: 'gone' });
      return Promise.resolve({ task: { ...t }, comments: [], activities: [] });
    }
    if (cmd === 'move_task') {
      const t = window.__MOCK__.tasks.find(t => t.id === args.id);
      if (!t) return Promise.reject({ code: 'TASK_NOT_FOUND', message: 'gone' });
      if (t.version !== args.version) return Promise.reject({ code: 'VERSION_CONFLICT', message: 'conflict (mock)' });
      t.status = args.status; t.version += 1;
      return Promise.resolve({ ...t });
    }
    if (cmd === 'update_task') {
      const t = window.__MOCK__.tasks.find(t => t.id === args.id);
      if (!t) return Promise.reject({ code: 'TASK_NOT_FOUND', message: 'gone' });
      if (t.version !== args.version) return Promise.reject({ code: 'VERSION_CONFLICT', message: 'conflict (mock)' });
      Object.assign(t, args.changes); t.version += 1;
      return Promise.resolve({ ...t });
    }
    if (cmd === 'add_label') {
      const p = window.__MOCK__.projects.find(p => p.id === args.projectId);
      if (!p) return Promise.reject({ code: 'PROJECT_NOT_FOUND', message: 'gone' });
      if (!p.labels.includes(args.label)) p.labels.push(args.label);
      return Promise.resolve({ id: p.id, labels: p.labels });
    }
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

  // 进 large 列表
  await evalJs(`document.getElementById('expandBtn').click(); 'ok'`);
  await sleep(600);

  // 断言 4：列表 blocked 任务按钮文案（协议收敛回归）
  const blockedBtn = await evalJs(`(document.querySelector('#list .item[data-id="T-6"] button[data-a="todo"]') || {}).textContent || 'none'`);
  check('P2-2a 列表 blocked 流转按钮文案「解除阻塞」', blockedBtn === '解除阻塞', `text="${blockedBtn}"`);

  // 打开 todo 详情
  await evalJs(`document.querySelector('#list .item[data-id="T-2"]').click(); 'ok'`);
  await sleep(500);
  const act1 = await evalJs(`(() => ({
    visible: document.getElementById('detail').style.display,
    buttons: [...document.querySelectorAll('#dAct button')].map(b => ({ label: b.textContent, a: b.dataset.a, primary: b.classList.contains('primary') })),
    status: document.getElementById('dStatus').textContent,
  }))()`);
  check('P2-2b todo 详情动作条 = 1 个「认领」primary', act1.buttons.length === 1 && act1.buttons[0].label === '认领' && act1.buttons[0].primary === true,
    JSON.stringify(act1.buttons));
  check('P2-2c 徽章显示「待处理」', act1.status === '待处理', `status="${act1.status}"`);

  // 点「认领」→ 徽章与动作条即时更新
  await evalJs(`document.querySelector('#dAct button[data-a="in_progress"]').click(); 'ok'`);
  await sleep(600);
  const act2 = await evalJs(`(() => ({
    status: document.getElementById('dStatus').textContent,
    buttons: [...document.querySelectorAll('#dAct button')].map(b => b.textContent + ':' + b.dataset.a),
  }))()`);
  check('P2-2d 认领后徽章变「进行中」', act2.status === '进行中', `status="${act2.status}"`);
  check('P2-2e 动作条更新为 推进+完成', act2.buttons.join(',') === '推进:in_review,完成:done', JSON.stringify(act2.buttons));

  // 冲突重试路径：外部改 version 制造过期，再点「完成」
  await evalJs(`window.__MOCK__.tasks.find(t => t.id === 'T-2').version += 1; 'bumped'`);
  await evalJs(`document.querySelector('#dAct button[data-a="done"]').click(); 'ok'`);
  await sleep(800);
  const act3 = await evalJs(`(() => ({
    status: document.getElementById('dStatus').textContent,
    buttons: document.querySelectorAll('#dAct button').length,
    toast: (document.getElementById('toast') || {}).textContent || '',
    toastShow: !!(document.getElementById('toast') || {}).classList?.contains?.('show'),
  }))()`);
  check('P2-2f 版本过期经重试后流转成功（徽章「已完成」）', act3.status === '已完成', `status="${act3.status}"`);
  check('P2-2g done 后动作条消失', act3.buttons === 0, `buttons=${act3.buttons}`);
  check('P2-2h 重试成功路径无误报 toast', act3.toastShow === false || !act3.toast.includes('请重试'), `toast="${act3.toast}" show=${act3.toastShow}`);

  // ---- v0.3.2 就地编辑：标题 / 描述（契约 id：#dTitleInput / #dDescEdit）----
  // 标题：点击进入编辑 → 改值回车 → 保存成功
  await evalJs(`document.getElementById('dTitle').click(); 'ok'`);
  await sleep(300);
  const titleEdit = await evalJs(`(() => {
    const inp = document.getElementById('dTitleInput');
    if (!inp) return { ok: false };
    inp.value = '就地编辑后的标题';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return { ok: true };
  })()`);
  await sleep(600);
  const titleAfter = await evalJs(`document.getElementById('dTitle') ? document.getElementById('dTitle').textContent : 'editing'`);
  check('P2-2i 标题点击编辑回车保存（#dTitle 契约）', titleEdit.ok === true && titleAfter === '就地编辑后的标题', `dTitle="${titleAfter}"`);

  // 标题：Esc 只退出编辑不关详情（App 级 Esc 分层）
  await evalJs(`document.getElementById('dTitle').click(); 'ok'`);
  await sleep(300);
  const escResult = await evalJs(`(() => {
    const inp = document.getElementById('dTitleInput');
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return new Promise(r => setTimeout(() => r({
      inputGone: !document.getElementById('dTitleInput'),
      detailStillOpen: document.getElementById('detail').style.display !== 'none',
      titleKept: document.getElementById('dTitle').textContent,
    }), 250));
  })()`);
  check('P2-2j Esc 退出编辑态但不关详情', escResult.inputGone === true && escResult.detailStillOpen === true && escResult.titleKept === '就地编辑后的标题',
    JSON.stringify(escResult));

  // 描述：无描述时「+ 补充描述」占位 → 点击进入 textarea → 回车保存
  const descBefore = await evalJs(`document.getElementById('dDesc') ? document.getElementById('dDesc').textContent : 'absent'`);
  await evalJs(`document.getElementById('dDesc').click(); 'ok'`);
  await sleep(300);
  const descEdit = await evalJs(`(() => {
    const ta = document.getElementById('dDescEdit');
    if (!ta) return { ok: false };
    ta.value = '人补的上下文描述';
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return { ok: true };
  })()`);
  await sleep(600);
  const descAfter = await evalJs(`document.getElementById('dDesc') ? document.getElementById('dDesc').textContent : 'editing'`);
  check('P2-2k 描述占位→编辑→保存（#dDescEdit 契约）', descBefore.includes('补充描述') && descEdit.ok === true && descAfter === '人补的上下文描述',
    `before="${descBefore}" after="${descAfter}"`);

  // 冲突重试：外部 bump version 后改标题 → 重读重试成功
  await evalJs(`window.__MOCK__.tasks.find(t => t.id === 'T-2').version += 1; 'bumped'`);
  await evalJs(`document.getElementById('dTitle').click(); 'ok'`);
  await sleep(300);
  await evalJs(`(() => {
    const inp = document.getElementById('dTitleInput');
    inp.value = '冲突重试后的标题';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return 'ok';
  })()`);
  await sleep(800);
  const conflictAfter = await evalJs(`(() => ({
    title: document.getElementById('dTitle') ? document.getElementById('dTitle').textContent : 'editing',
    toastShow: !!(document.getElementById('toast') || {}).classList?.contains?.('show'),
  }))()`);
  check('P2-2l 标题编辑版本过期经重试成功', conflictAfter.title === '冲突重试后的标题' && conflictAfter.toastShow === false,
    JSON.stringify(conflictAfter));

  // ---- v0.3.2 M3：优先级菜单 / 截止日编辑（契约 id：#dPri #dPriMenu #dDue #dDueInput #dDueClear）----
  // 优先级：high chip 点击弹 5 项菜单 → 选「低」→ chip 即时更新、mock 落库
  const priBefore = await evalJs(`document.getElementById('dPri').textContent`);
  await evalJs(`document.getElementById('dPri').click(); 'ok'`);
  await sleep(300);
  const priItems = await evalJs(`document.getElementById('dPriMenu') ? [...document.querySelectorAll('#dPriMenu button')].map(b => b.dataset.p).join(',') : null`);
  await evalJs(`document.querySelector('#dPriMenu button[data-p="low"]').click(); 'ok'`);
  await sleep(600);
  const priAfter = await evalJs(`(() => ({
    chip: document.getElementById('dPri').textContent,
    menuGone: !document.getElementById('dPriMenu'),
    mock: window.__MOCK__.tasks.find(t => t.id === 'T-2').priority,
  }))()`);
  check('P2-2m 优先级菜单切换 high→low（#dPriMenu 契约）',
    priBefore === '高优先级' && priItems === 'urgent,high,medium,low,none'
      && priAfter.chip === '低优先级' && priAfter.menuGone === true && priAfter.mock === 'low',
    `before="${priBefore}" items=${priItems} after=${JSON.stringify(priAfter)}`);

  // 菜单外点击收起（document pointerdown 兜底，不选不保存）
  await evalJs(`document.getElementById('dPri').click(); 'ok'`);
  await sleep(250);
  const menuOpened = await evalJs(`!!document.getElementById('dPriMenu')`);
  await evalJs(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); 'ok'`);
  await sleep(250);
  const menuClosed = await evalJs(`(() => !document.getElementById('dPriMenu'))()`);
  check('P2-2n 菜单外点击收起（不改值）', menuOpened === true && menuClosed === true,
    `opened=${menuOpened} closed=${menuClosed}`);

  // 截止日：无值「+ 截止日」入口 → 原生 date 选 2026-09-30 → chip 回显 + mock 落库
  const dueBefore = await evalJs(`document.getElementById('dDue') ? document.getElementById('dDue').textContent : null`);
  await evalJs(`document.getElementById('dDue').click(); 'ok'`);
  await sleep(300);
  await evalJs(`(() => {
    const inp = document.getElementById('dDueInput');
    if (!inp) return 'no-input';
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(inp, '2026-09-30');
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  await sleep(600);
  const dueAfter = await evalJs(`(() => ({
    chip: document.getElementById('dDue') ? document.getElementById('dDue').textContent : 'editing',
    mock: window.__MOCK__.tasks.find(t => t.id === 'T-2').dueDate,
  }))()`);
  check('P2-2o 截止日设置（#dDueInput 契约）', (dueBefore || '').includes('+ 截止日')
    && dueAfter.chip === '截止 2026-09-30' && dueAfter.mock === '2026-09-30',
    `before="${dueBefore}" after=${JSON.stringify(dueAfter)}`);

  // 截止日清除：再次进入编辑态 → × → 回到「+ 截止日」占位、mock 置 null
  await evalJs(`document.getElementById('dDue').click(); 'ok'`);
  await sleep(300);
  await evalJs(`document.getElementById('dDueClear').click(); 'ok'`);
  await sleep(600);
  const dueCleared = await evalJs(`(() => ({
    chip: document.getElementById('dDue').textContent,
    mock: window.__MOCK__.tasks.find(t => t.id === 'T-2').dueDate,
  }))()`);
  check('P2-2p 截止日清除（#dDueClear 契约）', dueCleared.chip.includes('+ 截止日') && dueCleared.mock === null,
    JSON.stringify(dueCleared));

  // ---- v0.3.2 M4：标签编辑（契约 id：#dLabels #dLabelMenu #dLabelInput）----
  // 展示：T-2 初始 1 个标签「设计」，chips 行回显
  const labelsShown = await evalJs(`(() => ({
    chips: [...document.querySelectorAll('#dLabels .label-chip')].map(c => c.dataset.label),
    none: !!document.querySelector('#dLabels .d-label-none'),
  }))()`);
  check('P2-2q 详情展示任务标签 chips（#dLabels 契约）',
    labelsShown.chips.join(',') === '设计' && labelsShown.none === false,
    JSON.stringify(labelsShown));

  // 勾选：编辑展开库菜单（2 项，设计=勾选态）→ 点「紧急修复」→ chip +1、mock 落库
  await evalJs(`[...document.querySelectorAll('.d-sec-labels .d-sec-btn')].find(b => b.textContent === '编辑').click(); 'ok'`);
  await sleep(300);
  const labelMenu = await evalJs(`(() => ({
    open: !!document.getElementById('dLabelMenu'),
    items: [...document.querySelectorAll('#dLabelMenu > button')].map(b => ({ label: b.textContent.trim(), on: b.classList.contains('on') })),
  }))()`);
  await evalJs(`[...document.querySelectorAll('#dLabelMenu > button')].find(b => b.textContent.includes('紧急修复')).click(); 'ok'`);
  await sleep(600);
  const labelToggled = await evalJs(`(() => ({
    chips: [...document.querySelectorAll('#dLabels .label-chip')].map(c => c.dataset.label),
    mock: window.__MOCK__.tasks.find(t => t.id === 'T-2').labels,
    menuKept: !!document.getElementById('dLabelMenu'),
  }))()`);
  check('P2-2r 库标签勾选追加（#dLabelMenu 契约）',
    labelMenu.open === true && labelMenu.items.length === 2 && labelMenu.items[0].on === true
      && labelToggled.chips.join(',') === '设计,紧急修复' && labelToggled.mock.join(',') === '设计,紧急修复',
    `menu=${JSON.stringify(labelMenu)} after=${JSON.stringify(labelToggled)}`);

  // 新建：输入「里程碑」Enter → 入库（mock 项目 labels）+ 自动勾选到任务
  await evalJs(`(() => {
    const inp = document.getElementById('dLabelInput');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(inp, '里程碑');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return 'ok';
  })()`);
  await sleep(800);
  const labelCreated = await evalJs(`(() => ({
    chips: [...document.querySelectorAll('#dLabels .label-chip')].map(c => c.dataset.label),
    catalog: window.__MOCK__.projects[0].labels,
    taskLabels: window.__MOCK__.tasks.find(t => t.id === 'T-2').labels,
    inputCleared: document.getElementById('dLabelInput') ? document.getElementById('dLabelInput').value : 'gone',
  }))()`);
  check('P2-2s 新标签入库并自动勾选（#dLabelInput 契约）',
    labelCreated.catalog.includes('里程碑') && labelCreated.taskLabels.includes('里程碑')
      && labelCreated.chips.join(',') === '设计,紧急修复,里程碑' && labelCreated.inputCleared === '',
    JSON.stringify(labelCreated));

  // 取消勾选：点已勾选的「设计」→ chip 消失、mock 同步移除
  await evalJs(`[...document.querySelectorAll('#dLabelMenu > button')].find(b => b.textContent.includes('设计')).click(); 'ok'`);
  await sleep(600);
  const labelOff = await evalJs(`(() => ({
    chips: [...document.querySelectorAll('#dLabels .label-chip')].map(c => c.dataset.label),
    mock: window.__MOCK__.tasks.find(t => t.id === 'T-2').labels,
  }))()`);
  check('P2-2t 取消勾选移除标签', labelOff.chips.join(',') === '紧急修复,里程碑' && labelOff.mock.join(',') === '紧急修复,里程碑',
    JSON.stringify(labelOff));

  // 详情态截图
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
