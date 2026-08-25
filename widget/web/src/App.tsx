/* ============================================================
 * App —— 视图相位状态机 + 全局键盘 + 启动序列
 *
 * 相位复刻旧 bridge.js switchView 时序：
 *   expand：显示 large(.entering) → set_window_size → 双 rAF 摘 entering
 *   collapse：closeDetailIfOpen → large(.leaving) → 120ms → reveal
 *   reveal：mini(.entering) + set_window_size(mini) → 双 rAF → mini
 * （旧 view:null 黑屏守卫陷阱在 React 状态驱动下结构性消失，见 store 注释）
 *
 * 全局键盘（移植自 main.js）：
 *   Esc → 详情返回；Enter/Space → div[role=button] 可达性补丁
 * ============================================================ */
import { useEffect, useState } from 'react';
import { loadData, setSize } from './lib/api';
import { SIZES } from './lib/types';
import { useAppStore } from './store/useAppStore';
import { usePolling } from './hooks/usePolling';
import { useRotate } from './hooks/useRotate';
import { useTauriEvents } from './hooks/useTauriEvents';
import Large from './components/Large';
import Mini from './components/Mini';
import Toast from './components/Toast';

type Phase = 'mini' | 'expand' | 'large' | 'collapse' | 'reveal';

export default function App() {
  const [phase, setPhase] = useState<Phase>('mini');
  const setView = useAppStore((s) => s.setView);

  // 启动序列（等价旧 main.js 末尾：connectEvents + loadData + startPolling）
  useTauriEvents();
  usePolling();
  useRotate();
  useEffect(() => {
    loadData().catch(() => useAppStore.getState().setOnline(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 启动一次
  }, []);

  // 展开：先显示 large（entering 态）→ 调窗口尺寸 → 下一帧移除 entering 触发过渡
  useEffect(() => {
    if (phase !== 'expand') return;
    setSize(SIZES.large.w, SIZES.large.h);
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setPhase('large')));
    return () => cancelAnimationFrame(raf);
  }, [phase]);

  // 收起：详情态静默重置（看板布局保留记忆）→ leaving → 120ms 后切 reveal
  useEffect(() => {
    if (phase !== 'collapse') return;
    useAppStore.getState().closeDetailIfOpen();
    const t = window.setTimeout(() => setPhase('reveal'), 120);
    return () => clearTimeout(t);
  }, [phase]);

  // reveal：mini 淡入（entering → 双 rAF 摘除）+ 恢复 mini 尺寸 + 重启轮转
  useEffect(() => {
    if (phase !== 'reveal') return;
    setSize(SIZES.mini.w, SIZES.mini.h);
    setView('mini');
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setPhase('mini')));
    return () => cancelAnimationFrame(raf);
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps -- setView 稳定引用

  // Esc：详情 → 来源视图（详情输入框聚焦时也生效）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && useAppStore.getState().largeView === 'detail') {
        useAppStore.getState().closeDetail();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // 键盘可达（P2-3）：div[role=button] 无原生键盘触发，统一补 Enter/Space
  // （原生 button 自带，跳过——否则条目内按钮会误触外层条目）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT') return;
      const host = (e.target as HTMLElement).closest?.('[role="button"]');
      if (host) {
        e.preventDefault();
        (host as HTMLElement).click();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const showLarge = phase !== 'mini' && phase !== 'reveal';

  return (
    <>
      <Mini
        hidden={phase !== 'mini' && phase !== 'reveal'}
        entering={phase === 'reveal'}
        onExpand={() => {
          setView('large');
          setPhase('expand');
        }}
      />
      <Large
        hidden={!showLarge}
        entering={phase === 'expand'}
        leaving={phase === 'collapse'}
        onCollapse={() => setPhase('collapse')}
      />
      <Toast />
    </>
  );
}
