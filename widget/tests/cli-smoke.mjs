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
}

rmSync(dataDir, { recursive: true, force: true });
console.log(failed ? `\n冒烟失败 ${failed} 项` : '\n冒烟全部通过');
process.exit(failed ? 1 : 0);
