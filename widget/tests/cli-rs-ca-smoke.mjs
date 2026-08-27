/* ============================================================
 * Rust CLI 冒烟——comment + attachment 簇（M3-B）
 *
 * 与 cli-smoke.mjs（Node 版契约基准）同模式的 spawnSync+check，但 spawn
 * 目标是 exe 双模式的 CLI 分支：
 *   taskdeck-widget.exe taskctl comment ... / attachment ...
 * 数据层为 widget/src-tauri/src/db.rs（与挂件同库同语义）。
 *
 * 前置：widget/src-tauri/target/debug/taskdeck-widget.exe 已构建
 * （cd widget/src-tauri && cargo build）。issue 簇尚未迁移到 Rust CLI，
 * 测试任务由 node:sqlite 直插（与 db.rs 单测同口径）。
 *
 * 运行：node widget/tests/cli-rs-ca-smoke.mjs
 * ============================================================ */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXE = path.join(REPO, 'widget', 'src-tauri', 'target', 'debug', 'taskdeck-widget.exe');

if (!existsSync(EXE)) {
  console.error(`未找到 ${EXE}`);
  console.error('请先构建 debug 产物：cd widget/src-tauri && cargo build');
  process.exit(1);
}

let failed = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `（${detail}）` : ''}`);
  if (!cond) failed++;
};

const dataDir = mkdtempSync(path.join(tmpdir(), 'taskdeck-cli-rs-ca-'));
const env = { ...process.env, VIBE_TASKDECK_DATA_DIR: dataDir };
delete env.CODEX_THREAD_ID; // thread-id 缺失用例不能被环境变量兜底

const run = (args) => spawnSync(EXE, ['taskctl', ...args], { encoding: 'utf8', env });
const runWith = (args, extraEnv) =>
  spawnSync(EXE, ['taskctl', ...args], { encoding: 'utf8', env: { ...env, ...extraEnv } });
const asJson = (r) => {
  try { return JSON.parse(r.stdout); } catch { return null; }
};
// exe 的 stderr 只有一行错误 JSON（无 node 警告混入），取末行兜底
const errJson = (r) => {
  const lines = (r.stderr || '').split(/\r?\n/).filter((line) => line.trim().length > 0);
  try { return JSON.parse(lines[lines.length - 1]); } catch { return null; }
};

// ---- 前置：初始化库（exe 首开自动建表 + seed local 项目），直插一条任务 ----
const init = run(['project', 'list', '--json']);
check('前置：exe 可执行且 project list 退出码 0', init.status === 0, (init.stderr || '').slice(0, 200));

const TASK = { id: '11111111-1111-4111-8111-111111111111', identifier: 'LOCAL-7' };
{
  const db = new DatabaseSync(path.join(dataDir, 'taskboard.sqlite'));
  db.prepare(
    `INSERT INTO tasks (id, identifier, project_id, title, description, status, priority,
       labels, sort_order, thread_id, creator_type, creator_id, creator_name,
       assignee_type, assignee_id, assignee_name, version, created_at, updated_at)
     VALUES (?, ?, 'local', 'Rust CLI 冒烟任务', '', 'todo', 'none', '[]', 1000, 'seed-thread',
       'agent', 'codex-agent', 'Codex Agent', 'agent', 'codex-agent', 'Codex Agent', 1,
       '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z')`,
  ).run(TASK.id, TASK.identifier);
  db.close();
}

// ---- comment 簇 ----
const addRun = run(['comment', 'add', TASK.id, '--body', '  第一条评论  ', '--thread-id', 'rs-ca-smoke']);
const added = asJson(addRun)?.comment;
check('comment add 退出码 0', addRun.status === 0, (addRun.stderr || '').slice(0, 200));
check('comment add 返回全字段契约（trim/actor/thread）',
  added?.id && added?.taskId === TASK.id
  && added?.body === '第一条评论'
  && added?.threadId === 'rs-ca-smoke'
  && added?.authorType === 'agent'
  && added?.authorId === 'codex-agent'
  && added?.authorName === 'Codex Agent'
  && added?.authorAvatarUrl === null
  && added?.version === 1
  && typeof added?.createdAt === 'string' && typeof added?.updatedAt === 'string');
check('comment add stdout 信封 schemaVersion: 2', asJson(addRun)?.schemaVersion === 2);

// actor env 覆盖（多 AI 区分）：ID+NAME 覆盖 / 仅 ID 覆盖时 NAME 回退为 ID
const actorBoth = asJson(runWith(['comment', 'add', TASK.id, '--body', 'actor 双覆盖', '--thread-id', 't'],
  { VIBE_TASKDECK_ACTOR_ID: 'claude-code', VIBE_TASKDECK_ACTOR_NAME: 'Claude Code' }))?.comment;
check('comment add actor env 覆盖（ID+NAME）',
  actorBoth?.authorId === 'claude-code' && actorBoth?.authorName === 'Claude Code');
const actorIdOnly = asJson(runWith(['comment', 'add', TASK.id, '--body', 'actor 仅 ID', '--thread-id', 't'],
  { VIBE_TASKDECK_ACTOR_ID: 'gemini-cli' }))?.comment;
check('comment add 仅覆盖 ID 时 NAME 回退为 ID',
  actorIdOnly?.authorId === 'gemini-cli' && actorIdOnly?.authorName === 'gemini-cli');

const emptyBody = run(['comment', 'add', TASK.id, '--body', '   ', '--thread-id', 't']);
check('comment add 纯空白 body → INVALID_FIELD（exit 4）',
  emptyBody.status === 4 && errJson(emptyBody)?.error?.code === 'INVALID_FIELD',
  `status=${emptyBody.status} code=${errJson(emptyBody)?.error?.code}`);
const noTask = run(['comment', 'add', 'no-such-task', '--body', 'x', '--thread-id', 't']);
check('comment add 任务不存在 → TASK_NOT_FOUND（exit 4）',
  noTask.status === 4 && errJson(noTask)?.error?.code === 'TASK_NOT_FOUND');
const noThread = run(['comment', 'add', TASK.id, '--body', 'x']);
check('comment add 缺 --thread-id → USAGE_ERROR（exit 2）',
  noThread.status === 2 && errJson(noThread)?.error?.code === 'USAGE_ERROR');

const listRun = run(['comment', 'list', TASK.identifier]); // identifier 寻址
const comments = asJson(listRun)?.comments;
check('comment list 退出码 0 且按 identifier 寻址',
  listRun.status === 0 && Array.isArray(comments) && comments.length === 3,
  (listRun.stderr || '').slice(0, 200));
check('comment list 返回全字段形状（含 threadId/authorId/authorAvatarUrl）',
  Array.isArray(comments) && comments.every((c) =>
    typeof c.id === 'string' && typeof c.taskId === 'string' && typeof c.body === 'string'
    && ('threadId' in c) && typeof c.authorType === 'string' && typeof c.authorId === 'string'
    && ('authorAvatarUrl' in c) && typeof c.version === 'number'
    && typeof c.createdAt === 'string' && typeof c.updatedAt === 'string'));
check('comment list 排序稳定（插入序，rowid tiebreaker）',
  Array.isArray(comments) && comments[0]?.body === '第一条评论' && comments[2]?.body === 'actor 仅 ID');
const listMissing = run(['comment', 'list', 'no-such-task']);
check('comment list 任务不存在 → TASK_NOT_FOUND（exit 4）',
  listMissing.status === 4 && errJson(listMissing)?.error?.code === 'TASK_NOT_FOUND');

// comment update：乐观锁 + thread 覆盖
const updRun = run(['comment', 'update', added.id,
  '--body', '  更新后的内容  ', '--thread-id', 'new-thread', '--if-version', '1']);
const updated = asJson(updRun)?.comment;
check('comment update 退出码 0 且 version 递增 / body trim / thread 覆盖',
  updRun.status === 0 && updated?.version === 2 && updated?.body === '更新后的内容'
  && updated?.threadId === 'new-thread',
  (updRun.stderr || '').slice(0, 200));
const updNoVersion = run(['comment', 'update', added.id, '--body', 'x', '--thread-id', 't']);
check('comment update 缺 --if-version → USAGE_ERROR（exit 2）',
  updNoVersion.status === 2 && errJson(updNoVersion)?.error?.code === 'USAGE_ERROR');
const updStale = run(['comment', 'update', added.id, '--body', 'x', '--thread-id', 't', '--if-version', '1']);
check('comment update 过期版本 → VERSION_CONFLICT（exit 5）',
  updStale.status === 5 && errJson(updStale)?.error?.code === 'VERSION_CONFLICT',
  `status=${updStale.status} code=${errJson(updStale)?.error?.code}`);
const updEmpty = run(['comment', 'update', added.id, '--body', '  ', '--thread-id', 't', '--if-version', '2']);
check('comment update 纯空白 body → INVALID_FIELD（exit 4）',
  updEmpty.status === 4 && errJson(updEmpty)?.error?.code === 'INVALID_FIELD');
const updMissing = run(['comment', 'update', 'no-such-comment', '--body', 'x', '--thread-id', 't', '--if-version', '1']);
check('comment update 评论不存在 → COMMENT_NOT_FOUND（exit 4）',
  updMissing.status === 4 && errJson(updMissing)?.error?.code === 'COMMENT_NOT_FOUND');

// comment delete：204 空响应契约 + 乐观锁
const delRun = run(['comment', 'delete', added.id, '--thread-id', 't', '--if-version', '2']);
check('comment delete 退出码 0 且输出仅 schemaVersion（对齐 HTTP 204）',
  delRun.status === 0 && JSON.stringify(asJson(delRun)) === '{"schemaVersion":2}',
  `stdout=${(delRun.stdout || '').trim()}`);
const delStale = run(['comment', 'delete', actorBoth.id, '--thread-id', 't', '--if-version', '99']);
check('comment delete 过期版本 → VERSION_CONFLICT（exit 5）',
  delStale.status === 5 && errJson(delStale)?.error?.code === 'VERSION_CONFLICT');
const delMissing = run(['comment', 'delete', 'no-such-comment', '--thread-id', 't', '--if-version', '1']);
check('comment delete 评论不存在 → COMMENT_NOT_FOUND（exit 4）',
  delMissing.status === 4 && errJson(delMissing)?.error?.code === 'COMMENT_NOT_FOUND');
const afterDelete = asJson(run(['comment', 'list', TASK.id]))?.comments;
check('comment delete 后 list 不含该评论',
  Array.isArray(afterDelete) && afterDelete.length === 2
  && !afterDelete.some((c) => c.id === added.id));

// ---- attachment 簇 ----
const srcBytes = Buffer.from('hello attachment rs');
const srcFile = path.join(dataDir, 'rs-att-source.txt');
writeFileSync(srcFile, srcBytes);

const upRun = run(['attachment', 'upload', '--task', TASK.id, '--file', srcFile]);
const up = asJson(upRun);
check('attachment upload --task 退出码 0', upRun.status === 0, (upRun.stderr || '').slice(0, 200));
check('attachment upload 返回附件元数据契约（含 guessContentType）',
  up?.attachment?.id && /^[0-9a-f-]{36}$/i.test(up.attachment.id)
  && up.attachment.filename === 'rs-att-source.txt'
  && up.attachment.contentType === 'text/plain'
  && up.attachment.size === srcBytes.length
  && typeof up.attachment.createdAt === 'string');
check('attachment upload file/target 契约',
  up?.file === srcFile && up?.target?.type === 'task' && up?.target?.id === TASK.id);
check('attachments/ 下出现 UUID 磁盘文件（与挂件同根互通）',
  existsSync(path.join(dataDir, 'attachments', String(up?.attachment?.id))));

const ctRun = run(['attachment', 'upload', '--task', TASK.id, '--file', srcFile,
  '--content-type', 'Image/PNG']);
check('--content-type 显式覆盖且归一为小写',
  ctRun.status === 0 && asJson(ctRun)?.attachment?.contentType === 'image/png',
  (ctRun.stderr || '').slice(0, 200));

// --comment：task_id 从评论行派生（DB 行级验证）
const upCommentRun = run(['attachment', 'upload', '--comment', actorIdOnly.id, '--file', srcFile]);
const upComment = asJson(upCommentRun);
check('attachment upload --comment 退出码 0 且 target 契约',
  upCommentRun.status === 0 && upComment?.target?.type === 'comment'
  && upComment?.target?.id === actorIdOnly.id,
  (upCommentRun.stderr || '').slice(0, 200));
{
  const db = new DatabaseSync(path.join(dataDir, 'taskboard.sqlite'));
  const row = db.prepare('SELECT task_id, comment_id FROM attachments WHERE id = ?')
    .get(String(upComment?.attachment?.id));
  check('upload --comment 时 DB 行 task_id 从评论派生 + comment_id 落库',
    row?.task_id === TASK.id && row?.comment_id === actorIdOnly.id, JSON.stringify(row));
  db.close();
}

// download：--output 落盘逐字节一致 + 输出契约
const outFile = path.join(dataDir, 'rs-att-download.txt');
const dlRun = run(['attachment', 'download', String(up?.attachment?.id), '--output', outFile]);
const dl = asJson(dlRun);
const roundtrip = existsSync(outFile) ? readFileSync(outFile) : null;
check('attachment download 退出码 0 且输出契约',
  dlRun.status === 0 && dl?.attachmentId === up?.attachment?.id
  && dl?.output === outFile && dl?.contentType === 'text/plain' && dl?.size === srcBytes.length,
  (dlRun.stderr || '').slice(0, 200));
check('attachment download 落盘内容与源文件逐字节一致',
  roundtrip !== null && roundtrip.equals(srcBytes));

// 错误契约
const missing = run(['attachment', 'download', '123e4567-e89b-42d3-a456-426614174000',
  '--output', path.join(dataDir, 'nope.txt')]);
check('download 不存在的 UUID → ATTACHMENT_NOT_FOUND（exit 4）',
  missing.status === 4 && errJson(missing)?.error?.code === 'ATTACHMENT_NOT_FOUND');
const badId = run(['attachment', 'download', '../etc/passwd', '--output', path.join(dataDir, 'nope.txt')]);
check('download 非 UUID id → INVALID_FIELD（exit 4）',
  badId.status === 4 && errJson(badId)?.error?.code === 'INVALID_FIELD');
const noOutput = run(['attachment', 'download', String(up?.attachment?.id)]);
check('download 缺 --output → USAGE_ERROR（exit 2）',
  noOutput.status === 2 && errJson(noOutput)?.error?.code === 'USAGE_ERROR');

const both = run(['attachment', 'upload', '--task', TASK.id,
  '--comment', actorIdOnly.id, '--file', srcFile]);
check('upload 同时给 --task 与 --comment → usage 错误（exit 2）',
  both.status === 2 && errJson(both)?.error?.code === 'USAGE_ERROR');
const neither = run(['attachment', 'upload', '--file', srcFile]);
check('upload --task 与 --comment 都不给 → usage 错误（exit 2）',
  neither.status === 2 && errJson(neither)?.error?.code === 'USAGE_ERROR');
const noSrc = run(['attachment', 'upload', '--task', TASK.id,
  '--file', path.join(dataDir, 'no-such-file.bin')]);
check('upload 源文件不存在 → FILE_READ_FAILED（exit 2）',
  noSrc.status === 2 && errJson(noSrc)?.error?.code === 'FILE_READ_FAILED');
const noTaskUp = run(['attachment', 'upload', '--task', 'no-such-task', '--file', srcFile]);
check('upload --task 任务不存在 → TASK_NOT_FOUND（exit 4）',
  noTaskUp.status === 4 && errJson(noTaskUp)?.error?.code === 'TASK_NOT_FOUND');
const noCommentUp = run(['attachment', 'upload', '--comment', 'no-such-comment', '--file', srcFile]);
check('upload --comment 评论不存在 → COMMENT_NOT_FOUND（exit 4）',
  noCommentUp.status === 4 && errJson(noCommentUp)?.error?.code === 'COMMENT_NOT_FOUND');

const bigFile = path.join(dataDir, 'rs-att-oversize.bin');
writeFileSync(bigFile, Buffer.alloc(10 * 1024 * 1024 + 1));
const big = run(['attachment', 'upload', '--task', TASK.id, '--file', bigFile]);
check('upload 超 10MB → ATTACHMENT_TOO_LARGE（exit 4）',
  big.status === 4 && errJson(big)?.error?.code === 'ATTACHMENT_TOO_LARGE');
rmSync(bigFile, { force: true });

// 超限/缺目标失败后不留孤儿磁盘文件（UUID 文件先写盘后入库只在全链路成功时发生）
{
  const leftovers = existsSync(path.join(dataDir, 'attachments'))
    ? spawnSync('node', ['-e',
      `const fs=require('fs');const d=${JSON.stringify(path.join(dataDir, 'attachments'))};`
      + `console.log(fs.readdirSync(d).filter((f)=>f!=='${up?.attachment?.id}'&&f!=='${ctRun && asJson(ctRun)?.attachment?.id}'&&f!=='${upComment?.attachment?.id}').length)`],
      { encoding: 'utf8' }).stdout.trim()
    : '0';
  check('失败用例不写孤儿磁盘文件（attachments/ 只有 3 个成功上传）', leftovers === '0', `leftovers=${leftovers}`);
}

rmSync(dataDir, { recursive: true, force: true });
console.log(failed ? `\n冒烟失败 ${failed} 项` : '\n冒烟全部通过');
process.exit(failed ? 1 : 0);
