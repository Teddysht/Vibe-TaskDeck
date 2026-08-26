/* ============================================================
 * 品牌 mark —— 与应用图标 A2（icons/icon.svg）完全同源：
 * 纯白底板 + 灰描边 + 三柱 brand-500/400/600，逐元素同值。
 * 应用图标若改版，此处需同步（同一构图语言）。
 * ============================================================ */
export default function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" fill="none" aria-hidden="true">
      <rect x="8" y="8" width="1008" height="1008" rx="216" fill="#F7F8FA" />
      <rect x="9.5" y="9.5" width="1005" height="1005" rx="214.5" stroke="#D5D9E2" strokeWidth="3" />
      <rect x="240" y="232" width="152" height="560" rx="48" fill="#6E8BFF" />
      <rect x="436" y="232" width="152" height="384" rx="48" fill="#8FA2FF" />
      <rect x="632" y="232" width="152" height="472" rx="48" fill="#4A63D6" />
    </svg>
  );
}
