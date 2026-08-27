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

  // ---- 3b. 关联契约（issue relation add/remove；写语义对齐 widget db.rs）----
  const run = (args) => spawnSync('node', [CLI, ...args], { encoding: 'utf8', env });
  // stderr 会混入 node:sqlite ExperimentalWarning，取最后一行 JSON 解析
  const errJson = (r) => {
    const lines = (r.stderr || '').split('\n').filter((line) => line.trim().startsWith('{'));
    try { return JSON.parse(lines[lines.length - 1] ?? ''); } catch { return null; }
  };
  const mkTask = (title) => asJson(run(['issue', 'create', '--project', 'local',
    '--title', title, '--thread-id', 't-rel', '--status', 'todo']))?.task;
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

  // ---- 3b+. v0.5.0 AI 工作流：move 护栏 + claim + fields + exe 专属命令 ----
  {
    const mk5 = (title, extra = []) => asJson(run(['issue', 'create', '--project', 'local',
      '--title', title, '--thread-id', 't-cli5', ...extra]))?.task;
    const backlogTask = mk5('v5-护栏-backlog');
    const guardMove = run(['issue', 'move', backlogTask?.id, '--status', 'in_progress', '--thread-id', 't-cli5']);
    check('move 护栏：backlog→in_progress 拒绝（TRANSITION_GUARD exit 4）',
      guardMove.status === 4 && errJson(guardMove)?.error?.code === 'TRANSITION_GUARD');
    const guardForce = run(['issue', 'move', backlogTask?.id, '--status', 'in_progress',
      '--thread-id', 't-cli5', '--force']);
    check('move 护栏：--force 逃生（exit 0）', guardForce.status === 0);
    const guardOther = run(['issue', 'move', backlogTask?.id, '--status', 'in_review', '--thread-id', 't-other5']);
    check('move 护栏：他人 in_progress 任务 → CLAIMED_BY_OTHER（exit 5）',
      guardOther.status === 5 && errJson(guardOther)?.error?.code === 'CLAIMED_BY_OTHER');

    const todoTask = mk5('v5-claim-todo', ['--status', 'todo']);
    const claim1 = run(['issue', 'claim', todoTask?.id, '--thread-id', 't-cli5']);
    check('claim：todo→in_progress 认领成功（claimed=true）',
      claim1.status === 0 && asJson(claim1)?.claimed === true
        && asJson(claim1)?.task?.status === 'in_progress');
    const claim2 = run(['issue', 'claim', todoTask?.id, '--thread-id', 't-cli5']);
    check('claim：幂等（claimed=false）',
      claim2.status === 0 && asJson(claim2)?.claimed === false);
    const claimOther = run(['issue', 'claim', todoTask?.id, '--thread-id', 't-other5']);
    check('claim：他人持有 → CLAIM_CONFLICT（exit 5）',
      claimOther.status === 5 && errJson(claimOther)?.error?.code === 'CLAIM_CONFLICT');
    const claimBacklog = mk5('v5-claim-backlog');
    const claimBk = run(['issue', 'claim', claimBacklog?.id, '--thread-id', 't-cli5']);
    check('claim：backlog 拒绝（CLAIM_REJECTED exit 4）',
      claimBk.status === 4 && errJson(claimBk)?.error?.code === 'CLAIM_REJECTED');

    const fieldsList = run(['issue', 'list', '--fields', 'id,title,status', '--json']);
    const fieldsTasks = asJson(fieldsList)?.tasks;
    check('issue list --fields 紧凑投影（键集合精确）',
      fieldsList.status === 0 && Array.isArray(fieldsTasks) && fieldsTasks.length > 0
        && fieldsTasks.every((t) => JSON.stringify(Object.keys(t).sort())
          === JSON.stringify(['id', 'status', 'title'])));
    const fieldsGet = run(['issue', 'get', todoTask?.id, '--fields', 'id,status,version']);
    check('issue get --fields 投影',
      fieldsGet.status === 0 && JSON.stringify(Object.keys(asJson(fieldsGet)?.task || {}).sort())
        === JSON.stringify(['id', 'status', 'version']));

    const exeOnly = run(['sync', '--thread-id', 't-cli5']);
    check('sync → EXE_ONLY（exit 2，指引构建 exe）',
      exeOnly.status === 2 && errJson(exeOnly)?.error?.code === 'EXE_ONLY');
    const exeOnlyReport = run(['report', '--thread-id', 't-cli5']);
    check('report → EXE_ONLY（exit 2）',
      exeOnlyReport.status === 2 && errJson(exeOnlyReport)?.error?.code === 'EXE_ONLY');
  }
  // ---- 3c. attachment upload/download 契约（磁盘 UUID 文件 + 元数据入库，10MB 上限对齐挂件）----
  // stderr 末行才是错误 JSON（node:sqlite 的 ExperimentalWarning 也写 stderr，会混在前几行）；
  // run 见 3b 共用定义
  const asErr = (r) => {
    const lines = (r.stderr || '').split(/\r?\n/).filter((line) => line.trim().length > 0);
    try { return JSON.parse(lines[lines.length - 1]); } catch { return null; }
  };

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
