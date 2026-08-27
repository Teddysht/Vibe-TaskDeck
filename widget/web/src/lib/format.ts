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

// Date → 本地时区 YYYY-MM-DD。DB 时间戳是 UTC ISO（带 Z），直接切字符串
// 在中国时区会慢 8 小时、凌晨 0–8 点日期错一天——凡"日期/今天"一律走本地换算。
export function localDate(d: Date): string {
  const mm = `${d.getMonth() + 1}`.padStart(2, '0');
  const dd = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

// 今天（本地时区 YYYY-MM-DD，与 dueDate 的日期串可直接比较）；用于逾期判断。
// 每次调用重算而非模块加载时固化——挂件常驻跨天后逾期判定才会翻转。
export function today(): string {
  return localDate(new Date());
}

export function isOverdue(d: string | null | undefined): boolean {
  return !!d && d < today();
}

const pad2 = (n: number): string => `${n}`.padStart(2, '0');

// ISO 时间 → "MM-DD HH:mm"（本地时区；评论/详情的时间展示，同日只显 HH:mm）
export function shortTime(iso: string | null | undefined): string {
  if (!iso || iso.length < 16) return '';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  const hhmm = `${pad2(t.getHours())}:${pad2(t.getMinutes())}`;
  const md = `${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`;
  return localDate(t) === today() ? hhmm : `${md} ${hhmm}`;
}
