// 回执闭环真机验证（v0.3.0 协议双向化）：不注入 mock，直接 execFile taskctl
// 写真实库（与挂件同库）。验证点：
//   R-1 AI 身份区分：VIBE_TASKDECK_ACTOR_ID/NAME → 创建/流转落该 actor
//   R-2 人机双向：不同 actor 的写操作在同一 --thread-id 活动流均可见
//   R-3 游标：activity list --since-id 增量轮询（nextSinceId 前移）
//   R-4 issue list --thread-id 只圈定本会话任务；--updated-since 过滤生效
// 前置：VIBE_TASKDECK_DATA_DIR 指向真实库（默认 <repo>/.data；与挂件同库时
// 可另起挂件验证事件广播，本脚本只验 CLI↔SQLite 链路，无需挂件在跑）。
import { execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TASKCTL = path.join(REPO, 'cli', 'taskctl-local.mjs');
const DATA_DIR = process.env.VIBE_TASKDECK_DATA_DIR || path.join(REPO, '.data');
const THREAD = `receipt-e2e-${Date.now().toString(36)}`;

fs.mkdirSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.out'), { recursive: true });

const results = [];
const check = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

function taskctl(args, actorEnv = {}) {
  return new Promise((res, rej) => {
    execFile('node', [TASKCTL, ...args], {
      timeout: 30000,
      env: { ...process.env, VIBE_TASKDECK_DATA_DIR: DATA_DIR, ...actorEnv },
    }, (err, stdout, stderr) => {
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
  const aiEnv = { VIBE_TASKDECK_ACTOR_ID: 'test-agent', VIBE_TASKDECK_ACTOR_NAME: '测试代理' };
  const humanEnv = { VIBE_TASKDECK_ACTOR_ID: 'human-kay', VIBE_TASKDECK_ACTOR_NAME: 'Kay' };

  // ---- R-1 AI 身份区分 ----
  const created = await taskctl(['issue', 'create', '--title', `回执验证 ${THREAD}`, '--project', 'local', '--status', 'todo', '--thread-id', THREAD], aiEnv);
  const tid = created.task?.id;
  check('R-1a AI 自定义身份创建（creatorId=test-agent）', created.task?.creatorId === 'test-agent' && created.task?.creatorName === '测试代理', `creator=${created.task?.creatorId}(${created.task?.creatorName})`);

  const moved = await taskctl(['issue', 'move', tid, '--status', 'in_progress', '--if-version', String(created.task.version), '--thread-id', THREAD], aiEnv);
  check('R-1b AI 流转成功（version 递增）', moved.task?.version === created.task.version + 1, `v${created.task.version}→${moved.task?.version}`);

  // ---- R-2 人机双向 ----
  const humanUpd = await taskctl(['issue', 'update', tid, '--title', '人改过的标题', '--if-version', String(moved.task.version), '--thread-id', THREAD], humanEnv);
  const feed = await taskctl(['activity', 'list', '--thread-id', THREAD, '--json']);
  const actors = new Set((feed.activities || []).map(a => a.actorId));
  check('R-2a 同会话活动流人机双方可见', actors.has('test-agent') && actors.has('human-kay'), `actors=${[...actors].join(',')}`);
  const humanAct = (feed.activities || []).find(a => a.actorId === 'human-kay');
  check('R-2b 人方变更含 diff（title before/after）', !!humanAct?.changes?.some(c => c.field === 'title' && c.after === '人改过的标题'), JSON.stringify(humanAct?.changes?.find(c => c.field === 'title') || null));

  // ---- R-3 游标增量 ----
  const lastId = feed.nextSinceId || feed.activities?.[feed.activities.length - 1]?.id;
  await taskctl(['issue', 'move', tid, '--status', 'in_review', '--if-version', String(humanUpd.task.version), '--thread-id', THREAD], aiEnv);
  const delta = await taskctl(['activity', 'list', '--thread-id', THREAD, '--since-id', lastId, '--json']);
  check('R-3 since-id 增量轮询只返回新活动', (delta.activities || []).length === 1 && delta.activities[0].changes?.some(c => c.field === 'status'), `delta=${delta.activities?.length} next=${delta.nextSinceId ? 'yes' : 'no'}`);

  // ---- R-4 过滤 ----
  const mine = await taskctl(['issue', 'list', '--thread-id', THREAD, '--json']);
  check('R-4a --thread-id 圈定本会话任务', mine.tasks?.length === 1 && mine.tasks[0].id === tid, `tasks=${mine.tasks?.length}`);
  const future = await taskctl(['issue', 'list', '--thread-id', THREAD, '--updated-since', '2030-01-01T00:00:00Z', '--json']);
  check('R-4b --updated-since 未来时间过滤为空', (future.tasks || []).length === 0, `tasks=${future.tasks?.length}`);

  // 清理：canceled（归档语义，与 agent-real 同口径）
  await taskctl(['issue', 'move', tid, '--status', 'canceled', '--if-version', '5', '--thread-id', THREAD], aiEnv).catch(() => {});
  console.log('测试任务已清理（canceled）');

  console.log('---');
  console.log(`结果: ${results.filter(r => r.pass).length}/${results.length} 通过`);
  process.exit(results.some(r => !r.pass) ? 2 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
