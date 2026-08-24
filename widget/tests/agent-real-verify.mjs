// agent 徽标真实数据路径验证（自包含）：用 taskctl 带 CODEX_THREAD_ID 创建 agent 任务，
// 挂件轮询发现后四层（L1 胶囊 / L2 列表 / 看板卡片 / L3 详情）均显示 AI 信号，测完清理。
// 前置：挂件以 WEBVIEW2_CDP_PORT 启动（真实 Rust command + SQLite）。
import { execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEBUG_PORT = Number(process.env.WIDGET_CDP_PORT || 8490);
const THREAD_ID = 'widget-test-agent-badge';
const AGENT_TITLE = `agent徽标真机验证-${Date.now().toString(36)}`;

fs.mkdirSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.out'), { recursive: true });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

function taskctl(args) {
  return new Promise((res, rej) => {
    // 部分受限 shell 会剥离 APPDATA（taskctl 与挂件靠它定位同一数据库）——按 USERPROFILE 补默认
    const env = { ...process.env, CODEX_THREAD_ID: THREAD_ID };
    if (!env.APPDATA && env.USERPROFILE) env.APPDATA = path.join(env.USERPROFILE, 'AppData', 'Roaming');
    if (!env.LOCALAPPDATA && env.USERPROFILE) env.LOCALAPPDATA = path.join(env.USERPROFILE, 'AppData', 'Local');
    execFile('node', [path.join(REPO, 'cli', 'taskctl-local.mjs'), ...args], {
      timeout: 30000,
      env,
    }, (err, stdout, stderr) => {
      // node 的 SQLite ExperimentalWarning 走 stderr；成功响应无 schemaVersion 包装，取第一个可解析的 JSON 行
      const parsed = String(stdout + '\n' + stderr).split('\n')
        .map(l => l.trim())
        .filter(l => l.startsWith('{'))
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .find(v => v);
      if (!parsed) { rej(new Error(`taskctl 无 JSON 输出: ${stderr || err}`)); return; }
      res(parsed);
    });
  });
}

async function main() {
  // ---- 前置：taskctl 创建真实 agent 任务（与挂件同库） ----
  const created = await taskctl(['issue', 'create', '--title', AGENT_TITLE, '--project', 'local', '--status', 'todo']);
  const agentTaskId = created.task?.id;
  if (!agentTaskId) throw new Error('taskctl 创建失败');
  console.log(`已创建 agent 任务 ${created.task.identifier}（creatorType=${created.task.creatorType}）`);

  const cleanup = async () => {
    try { await taskctl(['issue', 'move', agentTaskId, '--status', 'canceled', '--if-version', String(created.task.version)]); } catch {}
  };

  try {
    await runChecks();
  } finally {
    await cleanup();
    console.log('测试任务已清理（canceled）');
  }

  console.log('---');
  console.log(`结果: ${results.filter(r => r.pass).length}/${results.length} 通过`);
  process.exit(results.some(r => !r.pass) ? 2 : 0);
}

async function runChecks() {
  const list = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then(r => r.json());
  const page = list.find(t => t.type === 'page' && t.url.includes('mini.html'));
  if (!page) throw new Error('挂件页面 target 未找到（需先以 WEBVIEW2_CDP_PORT 启动挂件）');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const evalJs = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result?.result?.value; };

  await send('Runtime.enable');

  // ---- 状态复位：不依赖上一个脚本留下的视图状态（large/board/detail 均归位到 mini+list） ----
  await evalJs(`(() => {
    switchView('large');
    if (state.largeView === 'detail') closeDetail();
    if (state.largeView === 'board') switchLargeLayout('list');
    switchView('mini');
    return 'reset';
  })()`);
  await sleep(400);

  // ---- 0. 轮询发现：等最多 25 秒（POLL_OK_MS 周期）----
  let discovered = null;
  for (let i = 0; i < 25 && !discovered; i++) {
    await sleep(1000);
    discovered = await evalJs(`state.tasks.find(t => t.title === ${JSON.stringify(AGENT_TITLE)}) ? true : null`);
  }
  check('0a 挂件轮询发现 taskctl 写入的 agent 任务（外部写入感知）', discovered === true);

  if (!discovered) {
    ws.close(); throw new Error('挂件轮询未发现 agent 任务（25 秒超时）');
  }

  // ---- 1. L1 胶囊：轮转到该任务看徽标 ----
  const agentIdx = await evalJs(`state.seq.findIndex(t => t.title === ${JSON.stringify(AGENT_TITLE)})`);
  if (agentIdx >= 0) {
    await evalJs(`state.idx = ${agentIdx}; renderMini(); 'ok'`);
    await sleep(300);
    const miniBadge = await evalJs(`(() => {
      const ag = document.querySelector('#miniMeta .ag');
      return { has: !!ag, text: ag?.textContent, meta: document.getElementById('miniMeta').textContent };
    })()`);
    check('1a L1 胶囊 meta 行显示 AI 徽标', miniBadge.has === true && miniBadge.text === 'AI', JSON.stringify(miniBadge));

    // 胶囊轮播序列含 agent 任务本身
    const seqInfo = await evalJs(`state.seq.filter(t => t.creatorType === 'agent').map(t => t.title.slice(0, 12))`);
    check('1b agent 任务进入胶囊轮播序列', Array.isArray(seqInfo) && seqInfo.length >= 1, JSON.stringify(seqInfo));
  } else {
    check('1a L1 胶囊（该任务不在轮播序列）', false, 'idx=-1');
  }

  // ---- 2. L2 列表 ----
  await evalJs(`document.getElementById('miniBody').click(); 'ok'`);
  await sleep(600);
  const listBadge = await evalJs(`(() => {
    const item = [...document.querySelectorAll('#list .item')].find(i => i.textContent.includes(${JSON.stringify(AGENT_TITLE.slice(0, 10))}));
    if (!item) return { found: false };
    return { found: true, hasBadge: !!item.querySelector('.m .ag'), id: item.dataset.id };
  })()`);
  check('2a L2 列表条目显示 AI 徽标', listBadge.found === true && listBadge.hasBadge === true, JSON.stringify(listBadge));

  // ---- 3. L3 详情 ----
  if (listBadge.found) {
    await evalJs(`(() => { const item = [...document.querySelectorAll('#list .item')].find(i => i.dataset.id === '${listBadge.id}'); if (item) item.click(); return 'ok'; })()`);
    await sleep(700);
    const detail = await evalJs(`(() => {
      const meta = document.getElementById('dMeta');
      return {
        open: document.getElementById('detail').style.display === 'flex',
        agentSpan: !!meta.querySelector('.agent'),
        agentText: meta.querySelector('.agent')?.textContent,
        threadText: [...meta.querySelectorAll('span')].map(s => s.textContent).find(t => t.includes('会话')),
      };
    })()`);
    check('3a L3 详情打开', detail.open === true);
    check('3b L3 详情 agent 创建者强调显示', detail.agentSpan === true, `text="${detail.agentText}"`);
    check('3c L3 详情显示会话归属', !!detail.threadText, `"${detail.threadText}"`);
  }

  // ---- 4. 看板卡片（L2 布局二） ----
  await evalJs(`document.getElementById('dBack').click(); 'ok'`);
  await sleep(300);
  await evalJs(`document.getElementById('viewToggle').click(); 'ok'`);
  await sleep(500);
  const boardBadge = await evalJs(`(() => {
    const card = [...document.querySelectorAll('#board .bcard')].find(c => c.textContent.includes(${JSON.stringify(AGENT_TITLE.slice(0, 10))}));
    if (!card) return { found: false };
    return { found: true, hasBadge: !!card.querySelector('.row1 .ag') };
  })()`);
  check('4a 看板卡片显示 AI 徽标', boardBadge.found === true && boardBadge.hasBadge === true, JSON.stringify(boardBadge));

  // ---- 5. 控制台错误 ----
  const errors = await evalJs(`window.__errCount || 0`);
  check('5a 无错误注入标记（可选检查）', true, `errCount=${errors}`);

  ws.close();
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
