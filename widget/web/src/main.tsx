import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { initTheme } from './lib/theme';
import { moveTask } from './lib/api';
import { useAppStore } from './store/useAppStore';

initTheme();

// 调试钩子（e2e 测试契约）：
//   __widgetStore —— 替代旧全局 `state` 对象（e2e-real-verify.mjs 多处读状态）
//   __widgetApi.moveTask —— 替代旧全局函数（冲突重试真机路径）
declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    __widgetStore?: any;
    __widgetApi?: { moveTask: typeof moveTask };
  }
}
window.__widgetStore = useAppStore;
window.__widgetApi = { moveTask };

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
