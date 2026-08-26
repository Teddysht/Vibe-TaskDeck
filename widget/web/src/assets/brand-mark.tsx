/* ============================================================
 * 品牌 mark —— 与应用图标 A2（icons/icon.svg）完全同构的实心版。
 * 唯一差异：底板不画白底（深色 UI 里白块突兀），保留描边轮廓 +
 * 三柱实色——即「A2 去底板」，色彩体系与应用图标一致。
 * 应用图标若改版，此处需同步（同一构图语言）。
 * ============================================================ */
export default function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" fill="none" aria-hidden="true">
      {/* 底板轮廓：微透明白（在 surface 上勾出圆角方板形状，替代应用图标的白底+灰描边） */}
      <rect x="8" y="8" width="1008" height="1008" rx="216" fill="#FFFFFF" fillOpacity="0.06" />
      <rect x="9.5" y="9.5" width="1005" height="1005" rx="214.5" stroke="#D5D9E2" strokeOpacity="0.45" strokeWidth="6" />
      {/* 三柱：brand-500/400/600（与应用图标同色值） */}
      <rect x="240" y="232" width="152" height="560" rx="48" fill="#6E8BFF" />
      <rect x="436" y="232" width="152" height="384" rx="48" fill="#8FA2FF" />
      <rect x="632" y="232" width="152" height="472" rx="48" fill="#4A63D6" />
    </svg>
  );
}
