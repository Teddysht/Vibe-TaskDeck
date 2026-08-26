import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'motion/react';
import App from './App';
import './fullboard.css';
import { initTheme } from '../lib/theme';
import { useBoardStore } from './store/useBoardStore';

initTheme();

// 调试钩子（e2e 测试契约，对齐 mini 端 main.tsx）：
//   __widgetStore —— 看板 store（fb-real-verify.mjs 读状态/双窗口同步断言）
declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    __widgetStore?: any;
  }
}
window.__widgetStore = useBoardStore;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* reducedMotion="user"：motion 库全部动效（含 layout 平移）对系统
        减动效偏好瞬时完成，与 CSS 侧 prefers-reduced-motion 豁免同口径 */}
    <MotionConfig reducedMotion="user">
      <App />
    </MotionConfig>
  </StrictMode>,
);
