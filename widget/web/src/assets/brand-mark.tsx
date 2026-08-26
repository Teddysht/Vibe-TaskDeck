/* ============================================================
 * 品牌 mark —— 与应用图标 A2（icons/icon.svg）同一构图，双主题适配：
 * · 暗色（默认）：A2 原版——白底板 + 灰描边 + 三柱 brand 实色
 *   （白板在深色 UI 上即视觉锚点）
 * · 亮色：同构反色——brand 渐变底板 + 三柱白色
 *   （白底板在亮色 UI 上会「融化」，反色保对比）
 * CSS 经 .mark 变体切换（见 widget.css / fullboard.css 的 html.light 规则）。
 * 应用图标若改版，此处需同步（同一构图语言）。
 * ============================================================ */
export default function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="bm-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8FA2FF" />
          <stop offset="1" stopColor="#4A63D6" />
        </linearGradient>
      </defs>
      {/* 亮色版底板（默认隐藏；html.light 下 .mark-invert 切换可见性） */}
      <rect className="bm-light-board" x="8" y="8" width="1008" height="1008" rx="216" fill="url(#bm-grad)" />
      {/* 暗色版（默认）：白底板 + 灰描边 */}
      <g className="bm-dark-group">
        <rect x="8" y="8" width="1008" height="1008" rx="216" fill="#F7F8FA" />
        <rect x="9.5" y="9.5" width="1005" height="1005" rx="214.5" stroke="#D5D9E2" strokeWidth="3" />
      </g>
      {/* 暗色版三柱：brand 实色 */}
      <g className="bm-dark-group">
        <rect x="240" y="232" width="152" height="560" rx="48" fill="#6E8BFF" />
        <rect x="436" y="232" width="152" height="384" rx="48" fill="#8FA2FF" />
        <rect x="632" y="232" width="152" height="472" rx="48" fill="#4A63D6" />
      </g>
      {/* 亮色版三柱：白色 */}
      <g className="bm-light-group">
        <rect x="240" y="232" width="152" height="560" rx="48" fill="#FFFFFF" />
        <rect x="436" y="232" width="152" height="384" rx="48" fill="#FFFFFF" opacity="0.78" />
        <rect x="632" y="232" width="152" height="472" rx="48" fill="#FFFFFF" opacity="0.55" />
      </g>
    </svg>
  );
}
