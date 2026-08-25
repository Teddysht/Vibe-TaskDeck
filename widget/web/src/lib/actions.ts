/* ============================================================
 * 流转协议 —— 状态 → 下一步动作按钮（唯一事实源）
 * 列表 / 看板 / 详情三视图共享（移植自 render-board.js boardActions）
 * ============================================================ */

export interface BoardAction {
  s: string; // 目标状态
  label: string;
  primary?: boolean;
}

export function boardActions(t: { status: string }): BoardAction[] {
  switch (t.status) {
    case 'todo':
      return [{ s: 'in_progress', label: '认领', primary: true }];
    case 'in_progress':
      return [{ s: 'in_review', label: '推进' }, { s: 'done', label: '完成', primary: true }];
    case 'in_review':
      return [{ s: 'done', label: '接受', primary: true }, { s: 'in_progress', label: '退回' }];
    case 'blocked':
      return [{ s: 'todo', label: '解除阻塞' }];
    default:
      return []; // backlog / done / canceled 无快捷流转
  }
}
