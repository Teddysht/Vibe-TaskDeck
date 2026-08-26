/* ============================================================
 * motion 库动效 token —— 与 tokens.css --ease-out 同曲线
 * layout 位移（跨列滑动/重排）时长略长于 --duration-base(180ms)：
 * 位移要被看清，180ms 的淡入预算对滑动太赶。
 * ============================================================ */
import type { Transition } from 'motion/react';

export const layoutTransition: Transition = {
  duration: 0.28,
  ease: [0.16, 1, 0.3, 1],
};
