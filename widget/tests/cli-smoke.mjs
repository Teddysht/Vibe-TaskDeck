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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  // ---- 3b. attachment upload/download 契约（磁盘 UUID 文件 + 元数据入库，10MB 上限对齐挂件）----
  // stderr 末行才是错误 JSON（node:sqlite 的 ExperimentalWarning 也写 stderr，会混在前几行）
  const asErr = (r) => {
    const lines = (r.stderr || '').split(/\r?\n/).filter((line) => line.trim().length > 0);
    try { return JSON.parse(lines[lines.length - 1]); } catch { return null; }
  };
  const run = (args) => spawnSync('node', [CLI, ...args], { encoding: 'utf8', env });

  // 独立任务 + 评论（不复用上面已归档的任务）
  const attTaskRun = run(['issue', 'create', '--project', 'local',
    '--title', '附件冒烟任务', '--thread-id', 'ci-smoke']);
  const attTask = asJson(attTaskRun);
  check('attachment 前置：issue create 退出码 0', attTaskRun.status === 0, (attTaskRun.stderr || '').slice(0, 200));
  const commentRun = run(['comment', 'add', attTask?.task?.id,
    '--body', '附件冒烟评论', '--thread-id', 'ci-smoke']);
  const comment = asJson(commentRun);
  check('attachment 前置：comment add 退出码 0', commentRun.status === 0, (commentRun.stderr || '').slice(0, 200));

  // 源文件落在数据目录（随 rmSync 一并清理）
  const srcBytes = Buffer.from('hello attachment');
  const srcFile = path.join(dataDir, 'cli-att-source.txt');
  writeFileSync(srcFile, srcBytes);

  // upload --task：输出契约 {attachment, file, target} + 数据目录 attachments/ 下 UUID 文件
  const upRun = run(['attachment', 'upload', '--task', attTask?.task?.id, '--file', srcFile]);
  const up = asJson(upRun);
  check('attachment upload --task 退出码 0', upRun.status === 0, (upRun.stderr || '').slice(0, 200));
  check('attachment upload 返回附件元数据契约',
    up?.attachment?.id && /^[0-9a-f-]{36}$/i.test(up.attachment.id)
    && up.attachment.filename === 'cli-att-source.txt'
    && up.attachment.contentType === 'text/plain'
    && up.attachment.size === srcBytes.length
    && typeof up.attachment.createdAt === 'string');
  check('attachment upload file/target 契约',
    up?.file === srcFile && up?.target?.type === 'task' && up?.target?.id === attTask?.task?.id);
  check('attachments/ 下出现 UUID 磁盘文件',
    existsSync(path.join(dataDir, 'attachments', String(up?.attachment?.id))));

  // upload --comment：评论级附件
  const upCommentRun = run(['attachment', 'upload', '--comment', comment?.comment?.id, '--file', srcFile]);
  const upComment = asJson(upCommentRun);
  check('attachment upload --comment 退出码 0 且 target 契约',
    upCommentRun.status === 0 && upComment?.target?.type === 'comment'
    && upComment?.target?.id === comment?.comment?.id,
    (upCommentRun.stderr || '').slice(0, 200));

  // download：--output 落盘内容逐字节一致，contentType/size 回传正确
  const outFile = path.join(dataDir, 'cli-att-download.txt');
  const dlRun = run(['attachment', 'download', String(up?.attachment?.id), '--output', outFile]);
  const dl = asJson(dlRun);
  const roundtripBytes = existsSync(outFile) ? readFileSync(outFile) : null;
  check('attachment download 退出码 0 且输出契约',
    dlRun.status === 0 && dl?.attachmentId === up?.attachment?.id
    && dl?.output === outFile && dl?.contentType === 'text/plain' && dl?.size === srcBytes.length,
    (dlRun.stderr || '').slice(0, 200));
  check('attachment download 落盘内容与源文件逐字节一致',
    roundtripBytes !== null && roundtripBytes.equals(srcBytes));

  // 错误契约：不存在 UUID → ATTACHMENT_NOT_FOUND；非 UUID → INVALID_FIELD（均 exit 4）
  const missing = run(['attachment', 'download', '123e4567-e89b-42d3-a456-426614174000',
    '--output', path.join(dataDir, 'nope.txt')]);
  check('download 不存在的 UUID → ATTACHMENT_NOT_FOUND（exit 4）',
    missing.status === 4 && asErr(missing)?.error?.code === 'ATTACHMENT_NOT_FOUND');
  const badId = run(['attachment', 'download', '../etc/passwd', '--output', path.join(dataDir, 'nope.txt')]);
  check('download 非 UUID id → INVALID_FIELD（exit 4）',
    badId.status === 4 && asErr(badId)?.error?.code === 'INVALID_FIELD');

  // 错误契约：--task/--comment 恰好其一（usage 错误 exit 2）
  const both = run(['attachment', 'upload', '--task', attTask?.task?.id,
    '--comment', comment?.comment?.id, '--file', srcFile]);
  check('upload 同时给 --task 与 --comment → usage 错误（exit 2）',
    both.status === 2 && asErr(both)?.error?.code === 'USAGE_ERROR');
  const neither = run(['attachment', 'upload', '--file', srcFile]);
  check('upload --task 与 --comment 都不给 → usage 错误（exit 2）',
    neither.status === 2 && asErr(neither)?.error?.code === 'USAGE_ERROR');

  // 错误契约：源文件不存在 → FILE_READ_FAILED（exit 2）
  const noSrc = run(['attachment', 'upload', '--task', attTask?.task?.id,
    '--file', path.join(dataDir, 'no-such-file.bin')]);
  check('upload 源文件不存在 → FILE_READ_FAILED（exit 2）',
    noSrc.status === 2 && asErr(noSrc)?.error?.code === 'FILE_READ_FAILED');

  // 错误契约：10MB+1 字节 → ATTACHMENT_TOO_LARGE（exit 4；测完清理临时大文件）
  const bigFile = path.join(dataDir, 'cli-att-oversize.bin');
  writeFileSync(bigFile, Buffer.alloc(10 * 1024 * 1024 + 1));
  const big = run(['attachment', 'upload', '--task', attTask?.task?.id, '--file', bigFile]);
  check('upload 超 10MB → ATTACHMENT_TOO_LARGE（exit 4）',
    big.status === 4 && asErr(big)?.error?.code === 'ATTACHMENT_TOO_LARGE');
  rmSync(bigFile, { force: true });
}

rmSync(dataDir, { recursive: true, force: true });
console.log(failed ? `\n冒烟失败 ${failed} 项` : '\n冒烟全部通过');
process.exit(failed ? 1 : 0);
