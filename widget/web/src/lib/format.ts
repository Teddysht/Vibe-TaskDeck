/* ============================================================
 * 展示格式化工具 —— 移植自 config.js（esc 不再需要：React 文本节点自动转义）
 * ============================================================ */
import { PRI_LABEL } from './types';

// 状态 → 形状类（progress=强调实心 / blocked=红实心 / done=绿实心 / review=描边 / idle=空心 / canceled=横线）
export function shapeClass(s: string): string {
  return s === 'in_progress'
    ? 'progress'
    : s === 'blocked'
      ? 'blocked'
      : s === 'done'
        ? 'done'
        : s === 'in_review'
          ? 'review'
          : s === 'canceled'
            ? 'canceled'
            : 'idle';
}

// 是否展示优先级徽标（仅紧急/高显示，中低静默）
export function priBadge(p: string | null | undefined): string | null {
  return p === 'urgent' || p === 'high' ? p : null;
}

export function priLabel(p: string): string {
  return PRI_LABEL[p] ?? p;
}

// 日期裁剪为 YYYY-MM-DD
export function shortDate(d: string | null | undefined): string {
  return d ? d.slice(0, 10) : '';
}

// 今天（YYYY-MM-DD，ISO 字符串可直接比较）；用于逾期判断。
// 每次调用重算而非模块加载时固化——挂件常驻跨天后逾期判定才会翻转。
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function isOverdue(d: string | null | undefined): boolean {
  return !!d && d < today();
}

// ISO 时间 → "MM-DD HH:mm"（评论/详情的时间展示；同日只显 HH:mm）
export function shortTime(iso: string | null | undefined): string {
  if (!iso || iso.length < 16) return '';
  const now = new Date();
  const sameDay = iso.slice(0, 10) === now.toISOString().slice(0, 10);
  return sameDay ? iso.slice(11, 16) : `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
}
