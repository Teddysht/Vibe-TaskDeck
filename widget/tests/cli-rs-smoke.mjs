/* ============================================================
 * Rust CLI 契约冒烟（taskctl 簇：issue 全命令 + relation + activity +
 * context + project create；M3-A）
 *
 * 结构复制 cli-smoke.mjs 的 spawnSync+check 模式，但 spawn 目标是
 * cargo build 产物 taskdeck-widget.exe（argv[1] = "taskctl" 走 CLI 分支）。
 * 输出契约对齐 Node 版 cli/taskctl-local.mjs（成功信封 {…, schemaVersion: 2}、
 * 错误信封 {schemaVersion, error:{code,message}}、退出码 0/2/4/5）。
 *
 * 前置：exe 缺失时脚本先尝试 `cargo build`；构建失败（常见原因：
 * widget/dist/mini.html 缺失，需先在 widget/ 执行 `npm install && npm run build`）
 * 则打印指引退出 1。
 *
 * 运行：node widget/tests/cli-rs-smoke.mjs
 * ============================================================ */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXE = path.join(REPO, 'widget', 'src-tauri', 'target', 'debug', 'taskdeck-widget.exe');

if (!existsSync(EXE)) {
  console.log('taskdeck-widget.exe 不存在，尝试 cargo build ...');
  const build = spawnSync('cargo', ['build'], {
    cwd: path.join(REPO, 'widget', 'src-tauri'),
    encoding: 'utf8',
  });
  if (build.status !== 0 || !existsSync(EXE)) {
    console.error('构建失败：请先在 widget/ 执行 `npm install && npm run build`（产出 dist/），');
    console.error('再在 widget/src-tauri 执行 `cargo build` 后重跑本套件。');
    console.error((build.stderr || build.stdout || '').slice(0, 500));
    process.exit(1);
  }
}

const dataDir = mkdtempSync(path.join(tmpdir(), 'taskdeck-cli-rs-smoke-'));
const env = { ...process.env, VIBE_TASKDECK_DATA_DIR: dataDir, CODEX_THREAD_ID: '' };

let failed = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `（${detail}）` : ''}`);
  if (!cond) failed++;
};

const run = (args, extraEnv = {}) =>
  spawnSync(EXE, ['taskctl', ...args], { encoding: 'utf8', env: { ...env, ...extraEnv } });
const asJson = (r) => {
  try { return JSON.parse(r.stdout); } catch { return null; }
};
const asErr = (r) => {
  try { return JSON.parse(r.stderr); } catch { return null; }
};

/** CLI 宽形状 task 的 27 字段集合（对齐 cli/database.mjs #taskJson） */
const TASK_WIDE_KEYS = [
  'id', 'identifier', 'projectId', 'title', 'description', 'status', 'priority',
  'labels', 'sortOrder', 'threadId', 'creatorType', 'creatorId', 'creatorName',
  'creatorAvatarUrl', 'assigneeType', 'assigneeId', 'assigneeName', 'assigneeAvatarUrl',
  'workflowId', 'developmentContext', 'recurrence', 'startDate', 'dueDate',
  'archivedAt', 'version', 'createdAt', 'updatedAt',
];

// ---- 1. project list ----
const plist = run(['project', 'list', '--json']);
const plistJson = asJson(plist);
check('project list 退出码 0', plist.status === 0, (plist.stderr || '').slice(0, 200));
check('project list schemaVersion: 2 信封', plistJson?.schemaVersion === 2);
const localProject = plistJson?.projects?.find((p) => p.id === 'local');
check('project list 宽形状（labels/createdAt/updatedAt）+ local workspacePath 强制 null',
  localProject && Array.isArray(localProject.labels)
    && typeof localProject.createdAt === 'string' && localProject.workspacePath === null);

// ---- 2. project create ----
const pc = run(['project', 'create', '--name', 'Smoke 项目']);
const pcJson = asJson(pc);
check('project create 退出码 0 且 id 由 name slug 生成', pc.status === 0 && pcJson?.project?.id === 'smoke',
  (pc.stderr || '').slice(0, 200));
check('project create 返回宽形状 project',
  pcJson?.project?.name === 'Smoke 项目' && Array.isArray(pcJson?.project?.labels));
const pcDup = run(['project', 'create', '--name', 'Smoke 项目']);
check('project create 重复 id → PROJECT_EXISTS（exit 5）',
  pcDup.status === 5 && asErr(pcDup)?.error?.code === 'PROJECT_EXISTS',
  `status=${pcDup.status} code=${asErr(pcDup)?.error?.code}`);
const pcNoName = run(['project', 'create']);
check('project create 缺 --name → usage 错误（exit 2）',
  pcNoName.status === 2 && asErr(pcNoName)?.error?.code === 'USAGE_ERROR');

// ---- 3. issue create ----
const mk = (title, extra = []) => asJson(run(['issue', 'create', '--project', 'local',
  '--title', title, '--thread-id', 't-cli', ...extra]));
// v0.5.0 move 护栏：backlog→in_progress 需 --force，故冒烟主任务直接建为 todo
const a = mk('冒烟任务A', ['--status', 'todo']);
const b = mk('冒烟任务B');
const c = mk('冒烟任务C');
check('issue create 退出码 0 且 identifier 从 1 起', Boolean(a?.task && b?.task && c?.task)
  && a.task.identifier === 'LOCAL-1' && c.task.identifier === 'LOCAL-3');
check('issue create creator/assignee 为默认 agent actor',
  a.task.creatorType === 'agent' && a.task.creatorId === 'codex-agent'
    && a.task.creatorName === 'Codex Agent' && a.task.assigneeId === 'codex-agent');
check('issue create thread 归属 + version 从 1 起',
  a.task.threadId === 't-cli' && a.task.version === 1);
const labeled = mk('带标签任务', ['--labels', 'x, y ,x,z']);
check('issue create labels 逗号切分去重', JSON.stringify(labeled?.task?.labels) === '["x","y","z"]'
  || JSON.stringify(labeled?.task?.labels) === '["x","y","z"]');
const badStatus = run(['issue', 'create', '--project', 'local', '--title', 'X',
  '--status', 'bad', '--thread-id', 't-cli']);
check('issue create 非法 status → usage 错误（exit 2）',
  badStatus.status === 2 && asErr(badStatus)?.error?.code === 'USAGE_ERROR');
const noThread = run(['issue', 'create', '--project', 'local', '--title', 'X']);
check('issue create 缺 --thread-id → usage 错误（exit 2）',
  noThread.status === 2 && (asErr(noThread)?.error?.message || '').includes('thread-id'),
  (asErr(noThread)?.error?.message || '').slice(0, 80));
const noProject = run(['issue', 'create', '--project', 'no-such-proj', '--title', 'X', '--thread-id', 't-cli']);
check('issue create 项目不存在 → PROJECT_NOT_FOUND（exit 4）',
  noProject.status === 4 && asErr(noProject)?.error?.code === 'PROJECT_NOT_FOUND');
// actor env 覆盖（多 AI 区分）
const actorTask = asJson(run(['issue', 'create', '--project', 'local', '--title', 'actor任务',
  '--thread-id', 't-cli'], { VIBE_TASKDECK_ACTOR_ID: 'claude-agent', VIBE_TASKDECK_ACTOR_NAME: 'Claude' }));
check('issue create VIBE_TASKDECK_ACTOR_* 覆盖 creator',
  actorTask?.task?.creatorId === 'claude-agent' && actorTask?.task?.creatorName === 'Claude');

// ---- 4. issue list ----
const list = run(['issue', 'list', '--json']);
const listed = asJson(list);
check('issue list 退出码 0 且含刚建任务', list.status === 0
  && Array.isArray(listed?.tasks) && listed.tasks.some((t) => t.id === a?.task?.id));
const firstTask = listed?.tasks?.[0];
check('issue list task 为 27 字段宽形状',
  firstTask && TASK_WIDE_KEYS.every((k) => Object.hasOwn(firstTask, k))
    && Object.keys(firstTask).length === 27);
const byStatus = run(['issue', 'list', '--status', 'backlog', '--json']);
check('issue list --status 过滤',
  asJson(byStatus)?.tasks?.every((t) => t.status === 'backlog') === true);
const byLabel = run(['issue', 'list', '--label', 'z', '--json']);
check('issue list --label 过滤（JSON 元素匹配）',
  asJson(byLabel)?.tasks?.length === 1 && asJson(byLabel).tasks[0].id === labeled?.task?.id);
const bySearch = run(['issue', 'list', '--search', '冒烟任务B', '--json']);
check('issue list --search 标题包含过滤',
  asJson(bySearch)?.tasks?.length === 1 && asJson(bySearch).tasks[0].id === b?.task?.id);
const badArchived = run(['issue', 'list', '--archived', 'maybe']);
check('issue list --archived 非法值 → usage 错误（exit 2）', badArchived.status === 2);

// ---- 5. issue get ----
const get = run(['issue', 'get', a?.task?.id]);
const got = asJson(get);
check('issue get 退出码 0 且 task 含 comments/activities',
  get.status === 0 && Array.isArray(got?.task?.comments) && Array.isArray(got?.task?.activities));
check('issue get task 为宽形状 + 详情两键（29 键）',
  got?.task && TASK_WIDE_KEYS.every((k) => Object.hasOwn(got.task, k))
    && Object.keys(got.task).length === 29);
const getByIdentifier = run(['issue', 'get', 'LOCAL-1']);
check('issue get 按 identifier 定位', getByIdentifier.status === 0
  && asJson(getByIdentifier)?.task?.id === a?.task?.id);
const getMissing = run(['issue', 'get', 'no-such-task']);
check('issue get 不存在 → TASK_NOT_FOUND（exit 4）',
  getMissing.status === 4 && asErr(getMissing)?.error?.code === 'TASK_NOT_FOUND');

// ---- 6. issue update ----
const upd = run(['issue', 'update', a?.task?.id, '--title', '冒烟任务A改', '--thread-id', 't-cli']);
const updated = asJson(upd);
check('issue update 退出码 0 且 version+1', upd.status === 0
  && updated?.task?.title === '冒烟任务A改' && updated?.task?.version === 2);
check('issue update thread 不变则不记变更', updated?.task?.threadId === 't-cli');
const updStale = run(['issue', 'update', a?.task?.id, '--title', 'stale',
  '--if-version', '1', '--thread-id', 't-cli']);
check('issue update --if-version 过期 → VERSION_CONFLICT（exit 5）',
  updStale.status === 5 && asErr(updStale)?.error?.code === 'VERSION_CONFLICT');
const updEmpty = run(['issue', 'update', a?.task?.id, '--thread-id', 't-cli']);
check('issue update 无字段 → usage 错误（exit 2）', updEmpty.status === 2);

// ---- 7. issue move（缺省 if-version 自动取当前版本）----
const mv = run(['issue', 'move', a?.task?.id, '--status', 'in_progress', '--thread-id', 't-cli']);
check('issue move 退出码 0 且 version+1', mv.status === 0
  && asJson(mv)?.task?.status === 'in_progress' && asJson(mv)?.task?.version === 3);
const mvBad = run(['issue', 'move', a?.task?.id, '--status', 'bad', '--thread-id', 't-cli']);
check('issue move 非法 status → usage 错误（exit 2）', mvBad.status === 2);
const mvNoStatus = run(['issue', 'move', a?.task?.id, '--thread-id', 't-cli']);
check('issue move 缺 --status → usage 错误（exit 2）', mvNoStatus.status === 2);

// ---- 8. issue archive / restore ----
const arch = run(['issue', 'archive', b?.task?.id, '--thread-id', 't-cli']);
check('issue archive 退出码 0 且 archivedAt 非空', arch.status === 0
  && typeof asJson(arch)?.task?.archivedAt === 'string');
const listAll = run(['issue', 'list', '--archived', 'all', '--json']);
const listDefault = run(['issue', 'list', '--json']);
check('issue list --archived all 含已归档 / 默认不含',
  asJson(listAll)?.tasks?.some((t) => t.id === b?.task?.id) === true
  && asJson(listDefault)?.tasks?.some((t) => t.id === b?.task?.id) === false);
const archAgain = run(['issue', 'archive', b?.task?.id, '--if-version', '1', '--thread-id', 't-cli']);
check('issue archive 过期版本 → VERSION_CONFLICT（exit 5）',
  archAgain.status === 5 && asErr(archAgain)?.error?.code === 'VERSION_CONFLICT');
const restore = run(['issue', 'restore', b?.task?.id, '--thread-id', 't-cli']);
check('issue restore 退出码 0 且 archivedAt 置 null', restore.status === 0
  && asJson(restore)?.task?.archivedAt === null);
const restoreAgain = run(['issue', 'restore', b?.task?.id, '--thread-id', 't-cli']);
check('issue restore 未归档 → TASK_NOT_ARCHIVED（exit 4）',
  restoreAgain.status === 4 && asErr(restoreAgain)?.error?.code === 'TASK_NOT_ARCHIVED');

// ---- 9. issue relation ----
const relAdd = run(['issue', 'relation', 'add', a?.task?.id,
  '--type', 'blocks', '--issue', b?.task?.id, '--thread-id', 't-cli']);
const relAddJson = asJson(relAdd);
check('relation add 返回 {task, relatedTask} 且双方 version+1',
  relAdd.status === 0 && relAddJson?.task?.id === a?.task?.id
    && relAddJson?.relatedTask?.id === b?.task?.id
    // A：create1→update2→move3→add4；B：create1→archive2→restore3→add4
    && relAddJson.task.version === 4 && relAddJson.relatedTask.version === 4,
  `v=${relAddJson?.task?.version}/${relAddJson?.relatedTask?.version}`);
const relDup = run(['issue', 'relation', 'add', a?.task?.id,
  '--type', 'blocks', '--issue', b?.task?.id, '--thread-id', 't-cli']);
check('relation add 重复 → RELATION_EXISTS（exit 5）',
  relDup.status === 5 && asErr(relDup)?.error?.code === 'RELATION_EXISTS');
// parent 单父替换：A 的 parent 先设 C 再设 B → 旧边被替换
run(['issue', 'relation', 'add', a?.task?.id, '--type', 'parent', '--issue', c?.task?.id, '--thread-id', 't-cli']);
const parentReplace = run(['issue', 'relation', 'add', a?.task?.id,
  '--type', 'parent', '--issue', b?.task?.id, '--thread-id', 't-cli']);
check('relation add parent 换父替换成功（单父）', parentReplace.status === 0,
  (parentReplace.stderr || '').slice(0, 200));
const oldParentGone = run(['issue', 'relation', 'remove', a?.task?.id,
  '--type', 'parent', '--issue', c?.task?.id, '--thread-id', 't-cli']);
check('换父后旧 parent 边已被替换删除（RELATION_NOT_FOUND exit 4）',
  oldParentGone.status === 4 && asErr(oldParentGone)?.error?.code === 'RELATION_NOT_FOUND');
const cycle = run(['issue', 'relation', 'add', b?.task?.id,
  '--type', 'parent', '--issue', a?.task?.id, '--thread-id', 't-cli']);
check('parent 环检测 → INVALID_FIELD（exit 4）',
  cycle.status === 4 && asErr(cycle)?.error?.code === 'INVALID_FIELD');
const relRemove = run(['issue', 'relation', 'remove', a?.task?.id,
  '--type', 'parent', '--issue', b?.task?.id, '--thread-id', 't-cli']);
check('relation remove 成功返回 {task, relatedTask}',
  relRemove.status === 0 && asJson(relRemove)?.task?.id === a?.task?.id
    && asJson(relRemove)?.relatedTask?.id === b?.task?.id);
const relRemoveAgain = run(['issue', 'relation', 'remove', a?.task?.id,
  '--type', 'parent', '--issue', b?.task?.id, '--thread-id', 't-cli']);
check('relation remove 重复 → RELATION_NOT_FOUND（exit 4）',
  relRemoveAgain.status === 4 && asErr(relRemoveAgain)?.error?.code === 'RELATION_NOT_FOUND');
const relBadType = run(['issue', 'relation', 'add', a?.task?.id,
  '--type', 'sibling', '--issue', b?.task?.id, '--thread-id', 't-cli']);
check('relation --type 非法值 → usage 错误（exit 2）',
  relBadType.status === 2 && asErr(relBadType)?.error?.code === 'USAGE_ERROR');
const relBadAction = run(['issue', 'relation', 'link', a?.task?.id,
  '--type', 'related', '--issue', b?.task?.id, '--thread-id', 't-cli']);
check('relation action 非 add/remove → usage 错误（exit 2）', relBadAction.status === 2);
const relStale = run(['issue', 'relation', 'add', a?.task?.id,
  '--type', 'related', '--issue', b?.task?.id, '--if-version', '1', '--thread-id', 't-cli']);
check('relation --if-version 过期 → VERSION_CONFLICT（exit 5）',
  relStale.status === 5 && asErr(relStale)?.error?.code === 'VERSION_CONFLICT');
const relFresh = run(['issue', 'relation', 'add', a?.task?.id,
  '--type', 'related', '--issue', b?.task?.id, '--thread-id', 't-cli']);
check('relation 不带 --if-version 自动取当前版本（add 仍成功）',
  relFresh.status === 0, (relFresh.stderr || '').slice(0, 200));

// ---- 10. activity list ----
const feed = run(['activity', 'list', '--thread-id', 't-cli']);
const feedJson = asJson(feed);
check('activity list 退出码 0 且 {activities, nextSinceId}',
  feed.status === 0 && Array.isArray(feedJson?.activities) && 'nextSinceId' in feedJson);
const feedItem = feedJson?.activities?.[0];
check('activity 项字段齐全（id/taskId/taskIdentifier/taskTitle/actor*/changes/createdAt）',
  feedItem && ['id', 'taskId', 'taskIdentifier', 'taskTitle', 'actorType', 'actorId',
    'actorName', 'actorAvatarUrl', 'changes', 'createdAt'].every((k) => Object.hasOwn(feedItem, k)));
check('activity changes 为 [{field, before, after}] 且 actor 是 agent',
  Array.isArray(feedItem?.changes) && feedItem.changes.every((ch) => 'field' in ch && 'before' in ch && 'after' in ch)
    && feedItem.actorId === 'codex-agent' && feedItem.actorType === 'agent');
const lastActivityId = feedJson?.activities?.[feedJson.activities.length - 1]?.id;
const feedCursor = run(['activity', 'list', '--thread-id', 't-cli', '--since-id', String(lastActivityId)]);
check('activity list since-id 游标：末条之后为空且 nextSinceId 沿用游标',
  asJson(feedCursor)?.activities?.length === 0 && asJson(feedCursor)?.nextSinceId === lastActivityId);
const feedOther = run(['activity', 'list', '--thread-id', 'other-thread']);
check('activity list --thread-id 过滤圈会话（无关会话为空）',
  asJson(feedOther)?.activities?.length === 0);
const emptySince = run(['activity', 'list', '--since-id', '']);
check('activity list 空 since-id → usage 错误（exit 2）', emptySince.status === 2);

// ---- 11. context current ----
const wsDir = path.join(dataDir, 'workspace');
mkdirSync(wsDir, { recursive: true });
run(['project', 'create', '--name', 'WS 项目', '--id', 'ws-proj', '--workspace-path', wsDir]);
const ctx = run(['context', 'current', '--cwd', path.join(wsDir, 'sub')]);
const ctxJson = asJson(ctx);
check('context current 退出码 0 且 {cwd, project}',
  ctx.status === 0 && typeof ctxJson?.cwd === 'string' && ctxJson?.project?.id);
check('context current 按 workspaceContains 命中工作区项目',
  ctxJson?.project?.id === 'ws-proj', `project=${ctxJson?.project?.id}`);
const ctxFallback = run(['context', 'current', '--cwd', path.join(tmpdir(), 'nowhere')]);
check('context current 无命中回退 local 项目',
  asJson(ctxFallback)?.project?.id === 'local');

// ---- 12. 不支持命令（纯客户端无 server）----
const del = run(['issue', 'delete', a?.task?.id]);
check('issue delete → UNSUPPORTED_LOCAL（exit 2）',
  del.status === 2 && asErr(del)?.error?.code === 'UNSUPPORTED_LOCAL');

// ---- 13. v0.5.0 AI 工作流：move 护栏 + claim + fields + sync + report ----
const guardBacklog = mk('护栏-backlog');
const gbMove = run(['issue', 'move', guardBacklog?.task?.id, '--status', 'in_progress', '--thread-id', 't-cli']);
check('move 护栏：backlog→in_progress 拒绝（TRANSITION_GUARD exit 4）',
  gbMove.status === 4 && asErr(gbMove)?.error?.code === 'TRANSITION_GUARD');
const gbForce = run(['issue', 'move', guardBacklog?.task?.id, '--status', 'in_progress',
  '--thread-id', 't-cli', '--force']);
check('move 护栏：--force 逃生（exit 0）', gbForce.status === 0);
const gbOther = run(['issue', 'move', guardBacklog?.task?.id, '--status', 'in_review', '--thread-id', 't-other']);
check('move 护栏：他人 in_progress 任务 → CLAIMED_BY_OTHER（exit 5）',
  gbOther.status === 5 && asErr(gbOther)?.error?.code === 'CLAIMED_BY_OTHER');
const gbOtherForce = run(['issue', 'move', guardBacklog?.task?.id, '--status', 'in_review',
  '--thread-id', 't-other', '--force']);
check('move 护栏：他人任务 --force 逃生（exit 0）', gbOtherForce.status === 0);

const claimTodo = mk('claim-todo', ['--status', 'todo']);
const claim1 = run(['issue', 'claim', claimTodo?.task?.id, '--thread-id', 't-cli']);
check('claim：todo→in_progress 认领成功（claimed=true, version+1）',
  claim1.status === 0 && asJson(claim1)?.claimed === true
    && asJson(claim1)?.task?.status === 'in_progress' && asJson(claim1)?.task?.version === 2);
const claim2 = run(['issue', 'claim', claimTodo?.task?.id, '--thread-id', 't-cli']);
check('claim：幂等（claimed=false 不 bump version）',
  claim2.status === 0 && asJson(claim2)?.claimed === false
    && asJson(claim2)?.reason === 'already-claimed-by-this-thread'
    && asJson(claim2)?.task?.version === 2);
const claimOther = run(['issue', 'claim', claimTodo?.task?.id, '--thread-id', 't-other']);
check('claim：他人持有 → CLAIM_CONFLICT（exit 5，details 带持有者）',
  claimOther.status === 5 && asErr(claimOther)?.error?.code === 'CLAIM_CONFLICT'
    && (asErr(claimOther)?.error?.details || '').includes('t-cli'));
const claimBacklog = mk('claim-backlog');
const claimBk = run(['issue', 'claim', claimBacklog?.task?.id, '--thread-id', 't-cli']);
check('claim：backlog 拒绝（CLAIM_REJECTED exit 4）',
  claimBk.status === 4 && asErr(claimBk)?.error?.code === 'CLAIM_REJECTED');
const claimBkForce = run(['issue', 'claim', claimBacklog?.task?.id, '--thread-id', 't-cli', '--force']);
check('claim：backlog --force 认领（exit 0）',
  claimBkForce.status === 0 && asJson(claimBkForce)?.claimed === true);

const fieldsList = run(['issue', 'list', '--fields', 'id,identifier,title,status', '--json']);
const fieldsTasks = asJson(fieldsList)?.tasks;
check('issue list --fields 紧凑投影（键集合精确）',
  fieldsList.status === 0 && Array.isArray(fieldsTasks) && fieldsTasks.length > 0
    && fieldsTasks.every((t) => JSON.stringify(Object.keys(t).sort())
      === JSON.stringify(['id', 'identifier', 'status', 'title'])));
const fieldsBad = run(['issue', 'list', '--fields', 'id,bogus']);
check('issue list --fields 未知字段 → usage 错误（exit 2）',
  fieldsBad.status === 2 && asErr(fieldsBad)?.error?.code === 'USAGE_ERROR');
const fieldsGet = run(['issue', 'get', claimTodo?.task?.id, '--fields', 'id,status,version']);
check('issue get --fields 投影',
  fieldsGet.status === 0 && JSON.stringify(Object.keys(asJson(fieldsGet)?.task || {}).sort())
    === JSON.stringify(['id', 'status', 'version']));

const sync1 = run(['sync', '--thread-id', 't-cli']);
const sync1Json = asJson(sync1);
check('sync 首跑：mine 非空 + 活动增量 + nextSinceId',
  sync1.status === 0 && sync1Json?.mine?.length > 0
    && sync1Json?.activities?.length > 0 && typeof sync1Json?.nextSinceId === 'string');
check('sync 首跑：游标文件落盘 <dataDir>/taskctl-sync.json',
  existsSync(path.join(dataDir, 'taskctl-sync.json')));
const sync2 = run(['sync', '--thread-id', 't-cli']);
check('sync 二跑：增量活动为 0 + lastSyncAt 回传',
  sync2.status === 0 && asJson(sync2)?.activities?.length === 0
    && typeof asJson(sync2)?.lastSyncAt === 'string');
const sync3 = run(['sync', '--thread-id', 't-cli', '--reset']);
check('sync --reset：游标重置（活动非 0）',
  sync3.status === 0 && asJson(sync3)?.activities?.length > 0);

const rep = run(['report', '--thread-id', 't-cli']);
const repJson = asJson(rep);
check('report：summary.byStatus 七状态 + total',
  rep.status === 0 && repJson?.summary?.total > 0
    && Object.keys(repJson?.summary?.byStatus || {}).length === 7);
check('report：时间窗内活动非空 + 紧凑任务字段',
  repJson?.recentActivities?.length > 0
    && repJson?.overdue.every((t) => Object.keys(t).length <= 8)
    && repJson?.blocked.every((t) => Object.keys(t).length <= 8));
const repBad = run(['report', '--window', 'abc']);
check('report 非法 --window → usage 错误（exit 2）', repBad.status === 2);

rmSync(dataDir, { recursive: true, force: true });
console.log(failed ? `\n冒烟失败 ${failed} 项` : '\n冒烟全部通过');
process.exit(failed ? 1 : 0);
