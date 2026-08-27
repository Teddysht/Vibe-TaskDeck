/* ============================================================
 * CLI 契约冒烟（不依赖 Chrome，供 CI cli-test job 与本地使用）
 *
 * 三级门禁：
 *   1. 语法门禁：node --check cli/taskctl-local.mjs——任何环境必跑。
 *   2. 参数解析契约：import parseArgs 断言选项/位置参数切分——模块可解析即跑。
 *   3. 运行时契约：临时数据目录（VIBE_TASKDECK_DATA_DIR）跑
 *      project list / issue create / issue list，校验 stdout JSON 契约与退出码。
 *
 * 数据层说明：自研数据层 cli/database.mjs 随 v0.3.0 落地；此前 taskctl-local
 * 复用本地 upstream/ 快照（不入库）。数据层模块缺失时第 2、3 级跳过并注明，
 * 仅执行语法门禁——新克隆仓库属预期行为，不算失败。
 *
 * 运行：node widget/tests/cli-smoke.mjs
 * ============================================================ */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(REPO, 'cli', 'taskctl-local.mjs');

let failed = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `（${detail}）` : ''}`);
  if (!cond) failed++;
};

// ---- 1. 语法门禁（任何环境必跑）----
const syntax = spawnSync('node', ['--check', CLI], { encoding: 'utf8' });
check('node --check cli/taskctl-local.mjs', syntax.status === 0, syntax.stderr.slice(0, 200));

// ---- 2+3. 数据层可用性探测：模块缺失则跳过运行时契约 ----
const dataDir = mkdtempSync(path.join(tmpdir(), 'taskdeck-cli-smoke-'));
const env = { ...process.env, VIBE_TASKDECK_DATA_DIR: dataDir };
const probe = spawnSync('node', [CLI, 'project', 'list', '--json'], { encoding: 'utf8', env });
const missingLayer = probe.status !== 0 && /ERR_MODULE_NOT_FOUND/.test(probe.stderr || '');

if (missingLayer) {
  console.log('SKIP  参数解析/运行时契约：数据层模块缺失（自研 cli/database.mjs 随 v0.3.0 落地；'
    + '新克隆无本地 upstream/ 快照属预期），仅执行语法门禁');
} else {
  // ---- 2. 参数解析契约（纯函数，不触数据库）----
  const { parseArgs } = await import(`file://${CLI.replace(/\\/g, '/')}`);
  const parsed = parseArgs(['issue', 'list', '--project', 'local', '--json']);
  check('parseArgs 位置参数切分',
    parsed.resource === 'issue' && parsed.action === 'list' && parsed.operands.length === 0);
  check('parseArgs 选项归置（值型 + 布尔型）',
    parsed.options.project === 'local' && parsed.options.json === true);
  let usageThrown = false;
  try { parseArgs(['issue', 'list', '--json=x']); } catch (e) { usageThrown = e.exitCode === 2; }
  check('parseArgs 布尔选项拒绝取值（usage 错误 exitCode 2）', usageThrown);

  // ---- 3. 运行时契约（临时库，跑完即删）----
  const asJson = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };

  const list = probe;
  check('project list --json 退出码 0', list.status === 0, (list.stderr || '').slice(0, 200));
  check('project list 输出 schemaVersion: 2 契约', asJson(list)?.schemaVersion === 2);

  const create = spawnSync('node', [CLI, 'issue', 'create', '--project', 'local',
    '--title', 'CLI 冒烟任务', '--thread-id', 'ci-smoke'], { encoding: 'utf8', env });
  const created = asJson(create);
  check('issue create 退出码 0', create.status === 0, (create.stderr || '').slice(0, 200));
  check('issue create 返回 identifier',
    typeof created?.task?.identifier === 'string' && created.task.identifier.length > 0);

  const issues = spawnSync('node', [CLI, 'issue', 'list', '--project', 'local', '--json'],
    { encoding: 'utf8', env });
  const listed = asJson(issues);
  const roundTrip = Array.isArray(listed?.tasks) && listed.tasks.some((i) => i.id === created?.task?.id);
  check('issue list 往返能读到刚建任务', issues.status === 0 && roundTrip);

  // 归档过滤契约：--archived all 必须同时含未归档与已归档（回归：自研层曾把
  // all 降级成只看未归档，且空过滤条件会拼出 WHERE ORDER 语法错误）
  const arch = spawnSync('node', [CLI, 'issue', 'archive', created?.task?.identifier,
    '--if-version', '1', '--thread-id', 'ci-smoke'], { encoding: 'utf8', env });
  check('issue archive 退出码 0', arch.status === 0, (arch.stderr || '').slice(0, 200));
  const all = asJson(spawnSync('node', [CLI, 'issue', 'list', '--archived', 'all', '--json'],
    { encoding: 'utf8', env }));
  check('--archived all 含已归档任务',
    Array.isArray(all?.tasks) && all.tasks.some((i) => i.id === created?.task?.id));
  const active = asJson(spawnSync('node', [CLI, 'issue', 'list', '--json'],
    { encoding: 'utf8', env }));
  check('默认列表不含已归档任务',
    Array.isArray(active?.tasks) && !active.tasks.some((i) => i.id === created?.task?.id));

  // ---- 3b. 关联契约（issue relation add/remove；写语义对齐 widget db.rs）----
  const run = (args) => spawnSync('node', [CLI, ...args], { encoding: 'utf8', env });
  // stderr 会混入 node:sqlite ExperimentalWarning，取最后一行 JSON 解析
  const errJson = (r) => {
    const lines = (r.stderr || '').split('\n').filter((line) => line.trim().startsWith('{'));
    try { return JSON.parse(lines[lines.length - 1] ?? ''); } catch { return null; }
  };
  const mkTask = (title) => asJson(run(['issue', 'create', '--project', 'local',
    '--title', title, '--thread-id', 't-rel']))?.task;
  const taskA = mkTask('relation-A');
  const taskB = mkTask('relation-B');
  const taskC = mkTask('relation-C');
  check('relation 前置：建 A/B/C 三任务', Boolean(taskA && taskB && taskC));

  if (taskA && taskB && taskC) {
    const add = asJson(run(['issue', 'relation', 'add', taskA.id,
      '--type', 'blocks', '--issue', taskB.id, '--thread-id', 't-rel']));
    check('relation add blocks 返回 {task, relatedTask}',
      add?.task?.id === taskA.id && add?.relatedTask?.id === taskB.id);
    check('relation add 后双方 version 均 +1（v1→v2）',
      add?.task?.version === 2 && add?.relatedTask?.version === 2);

    const dup = run(['issue', 'relation', 'add', taskA.id,
      '--type', 'blocks', '--issue', taskB.id, '--thread-id', 't-rel']);
    check('relation add 重复 → RELATION_EXISTS（退出码非 0）',
      dup.status !== 0 && errJson(dup)?.error?.code === 'RELATION_EXISTS',
      `status=${dup.status} code=${errJson(dup)?.error?.code}`);

    // parent 单父替换：A 的 parent 先设 C 再设 B → 旧边被替换
    const parentFirst = run(['issue', 'relation', 'add', taskA.id,
      '--type', 'parent', '--issue', taskC.id, '--thread-id', 't-rel']);
    const parentReplace = run(['issue', 'relation', 'add', taskA.id,
      '--type', 'parent', '--issue', taskB.id, '--thread-id', 't-rel']);
    check('relation add parent 换父替换成功（单父）',
      parentFirst.status === 0 && parentReplace.status === 0,
      `first=${parentFirst.status} second=${parentReplace.status}`);
    const oldParentGone = run(['issue', 'relation', 'remove', taskA.id,
      '--type', 'parent', '--issue', taskC.id, '--thread-id', 't-rel']);
    check('换父后旧 parent 边已被替换删除（RELATION_NOT_FOUND）',
      oldParentGone.status !== 0 && errJson(oldParentGone)?.error?.code === 'RELATION_NOT_FOUND');

    // parent 环检测：A 的 parent 是 B，再设 B 的 parent 为 A → 环
    const cycle = run(['issue', 'relation', 'add', taskB.id,
      '--type', 'parent', '--issue', taskA.id, '--thread-id', 't-rel']);
    check('parent 环检测 → INVALID_FIELD',
      cycle.status !== 0 && errJson(cycle)?.error?.code === 'INVALID_FIELD',
      `code=${errJson(cycle)?.error?.code}`);

    const remove = asJson(run(['issue', 'relation', 'remove', taskA.id,
      '--type', 'parent', '--issue', taskB.id, '--thread-id', 't-rel']));
    check('relation remove 成功返回 {task, relatedTask}',
      remove?.task?.id === taskA.id && remove?.relatedTask?.id === taskB.id);
    const removeAgain = run(['issue', 'relation', 'remove', taskA.id,
      '--type', 'parent', '--issue', taskB.id, '--thread-id', 't-rel']);
    check('relation remove 重复 → RELATION_NOT_FOUND',
      removeAgain.status !== 0 && errJson(removeAgain)?.error?.code === 'RELATION_NOT_FOUND');

    const badType = run(['issue', 'relation', 'add', taskA.id,
      '--type', 'sibling', '--issue', taskB.id, '--thread-id', 't-rel']);
    check('--type 非法值 → usage 错误（退出码 2 / USAGE_ERROR）',
      badType.status === 2 && errJson(badType)?.error?.code === 'USAGE_ERROR');

    // 版本口径：不带 --if-version 自动取当前版本；带过期版本 → VERSION_CONFLICT（退出码 5）
    const bumped = run(['issue', 'move', taskA.id, '--status', 'in_progress', '--thread-id', 't-rel']);
    const stale = run(['issue', 'relation', 'add', taskA.id,
      '--type', 'related', '--issue', taskB.id, '--if-version', '1', '--thread-id', 't-rel']);
    check('--if-version 过期 → VERSION_CONFLICT（退出码 5）',
      bumped.status === 0 && stale.status === 5 && errJson(stale)?.error?.code === 'VERSION_CONFLICT',
      `bump=${bumped.status} stale=${stale.status}`);
    const fresh = run(['issue', 'relation', 'add', taskA.id,
      '--type', 'related', '--issue', taskB.id, '--thread-id', 't-rel']);
    check('不带 --if-version 自动取当前版本（手动 bump 后 add 仍成功）',
      fresh.status === 0, (fresh.stderr || '').slice(0, 200));
  }
}

rmSync(dataDir, { recursive: true, force: true });
console.log(failed ? `\n冒烟失败 ${failed} 项` : '\n冒烟全部通过');
process.exit(failed ? 1 : 0);
