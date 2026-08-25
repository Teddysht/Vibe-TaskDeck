/* ============================================================
 * 数据层 —— 移植自 api.js（Tauri invoke / 事件 / 轮询的命令封装）
 *
 * 纯客户端架构：读写全部走 Rust command 直连 SQLite。
 *   · 挂件自身的写操作 → Rust emit task-created/task-moved → 即时刷新
 *   · 外部写入（taskctl / server 模式同库）→ 靠轮询兜底发现
 * 事件监听与轮询的定时器生命周期见 hooks/（StrictMode 双挂载安全）。
 * ============================================================ */
import { invoke } from './tauri';
import { errMsg, showToast } from './toast';
import { useAppStore } from '../store/useAppStore';
import {
  isCommandError,
  type CreateTaskInput,
  type IssueDetail,
  type Project,
  type Task,
} from './types';

// 拉取任务与项目（成功即置在线）
export async function loadData(): Promise<void> {
  const data = await invoke<{ tasks?: Task[]; projects?: Project[] }>('load_data');
  useAppStore.getState().setData(data.tasks ?? [], data.projects ?? [], true);
}

// 新建任务（挂件表单）
export function createTask(input: CreateTaskInput): Promise<unknown> {
  return invoke('create_task', { ...input });
}

// 写操作：move（乐观并发，version 过期 → 重读重试一次）
export async function moveTask(task: { id: string; version: number }, status: string): Promise<void> {
  const doMove = async (version: number) => {
    try {
      return await invoke('move_task', { id: task.id, version, status });
    } catch (e) {
      if (isCommandError(e) && e.code === 'VERSION_CONFLICT') return { conflict: true };
      throw e;
    }
  };

  let result = await doMove(task.version);
  if (result && (result as { conflict?: boolean }).conflict) {
    // 版本过期：重读最新 version 后重试一次
    await loadData().catch(() => {});
    const fresh = useAppStore.getState().tasks.find((t) => t.id === task.id);
    if (!fresh) throw new Error('任务已被删除，流转未生效');
    if (fresh.version) result = await doMove(fresh.version);
  }
  // 无论成败都刷新一次（成功用最新数据）
  await loadData().catch(() => {});
  // 二次仍冲突：抛错让调用方提示用户，不再静默等轮询兜底
  if (result && (result as { conflict?: boolean }).conflict) {
    throw new Error('任务刚被外部修改，请重试');
  }
}

// 任务详情（task 全字段 + 评论 + 活动流）
export function issueDetail(id: string): Promise<IssueDetail> {
  return invoke<IssueDetail>('issue_detail', { id });
}

// 发表评论（归属挂件会话）
export function addComment(taskId: string, body: string): Promise<unknown> {
  return invoke('add_comment', { taskId, body });
}

// L3-全版：拉起 server + 开第二窗口（Rust 侧完成，可能耗时 ~20s）
export function openFullBoard(): Promise<unknown> {
  return invoke('open_full_board');
}

// 调整宿主窗口尺寸
export function setSize(w: number, h: number): void {
  invoke('set_window_size', { w, h }).catch(() => {});
}

// 退出挂件
export function closeWidget(): void {
  invoke('close_window', {}).catch(() => {});
}

// 拉取并写入详情数据（任务被外部删除时退回列表；其他错误 toast 提示而非静默吞掉）
export async function refreshDetail(): Promise<void> {
  const { detailId, setDetail, closeDetail } = useAppStore.getState();
  if (!detailId) return;
  try {
    setDetail(await issueDetail(detailId));
  } catch (e) {
    if (isCommandError(e) && e.code === 'TASK_NOT_FOUND') {
      closeDetail();
      return;
    }
    console.error('issue_detail failed', e);
    showToast(errMsg(e, '加载详情失败'), true);
  }
}

// 事件监听（task-created / task-moved / task-comment）见 hooks/useTauriEvents.ts
// （事件名不得含点号——Tauri v2 校验只允许字母数字与 - / : _；
//   旧名 task.* 曾被静默拒绝，一直靠轮询兜底，迁移时已修正）
