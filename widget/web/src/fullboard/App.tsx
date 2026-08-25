/* ============================================================
 * 全版看板 App —— 顶栏 + 筛选栏 + 看板/列表视图 + 详情抽屉 + undo
 * 视图与筛选均 URL 同步（?view=list&status=…&content=…）。
 * ============================================================ */
import { useEffect, useState } from 'react';
import { loadBoardData, markOffline } from './api';
import { useBoardEvents, useBoardPolling } from './hooks/useBoardEvents';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useBoardStore } from './store/useBoardStore';
import BoardView from './board/BoardView';
import TaskDetailPanel from './detail/TaskDetailPanel';
import IssueListView from './list/IssueListView';
import FilterBar from './filters/FilterBar';
import OtherTasksPanel from './panels/OtherTasksPanel';
import TaskContextMenu, { type MenuState } from './shared/TaskContextMenu';
import WindowControls from './shared/WindowControls';
import Toast from '../components/Toast';
import ThemeToggle from '../components/ThemeToggle';
import type { Task } from '../lib/types';
import { getCurrentWindow } from '@tauri-apps/api/window';

// 双击标题栏切换最大化（getCurrentWindow 依赖窗口元数据，mock/浏览器环境
// 直接调用会抛错——只在事件回调里 try/catch 调用，模块加载无副作用）
function toggleMaximize() {
  try {
    getCurrentWindow().toggleMaximize().catch(() => {});
  } catch {
    /* no window */
  }
}

export default function App() {
  useBoardEvents();
  useBoardPolling();
  useKeyboardShortcuts();
  useEffect(() => {
    loadBoardData().catch(markOffline);
    // 启动恢复视图模式
    const view = new URLSearchParams(window.location.search).get('view');
    if (view === 'list') useBoardStore.getState().setViewMode('list');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 启动一次
  }, []);

  const online = useBoardStore((s) => s.online);
  const viewMode = useBoardStore((s) => s.viewMode);
  const setViewMode = useBoardStore((s) => s.setViewMode);
  const selectedId = useBoardStore((s) => s.selectedId);
  const select = useBoardStore((s) => s.select);
  const [menu, setMenu] = useState<MenuState | null>(null);

  function onCardClick(task: Task) {
    select(task.id);
  }

  function switchView(v: 'board' | 'list') {
    setViewMode(v);
    const url = new URL(window.location.href);
    if (v === 'list') url.searchParams.set('view', 'list');
    else url.searchParams.delete('view');
    window.history.replaceState(null, '', url);
  }

  return (
    <div className="fb-root flex h-full flex-col">
      {/* 无框自绘标题栏：drag 区承载窗口拖拽与双击最大化（语言对齐挂件 .hd） */}
      <header
        className="fb-header"
        onDoubleClick={toggleMaximize}
      >
        <div className="fb-brand">
          <div className="mark">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="4" y="5" width="16" height="16" rx="3" />
              <path d="M8 9h8M8 13h8M8 17h5" />
            </svg>
          </div>
          <div className="tt">任务看板</div>
        </div>
        <div className="fb-viewtoggle">
          <button className={viewMode === 'board' ? 'on' : ''} onClick={() => switchView('board')}>看板</button>
          <button className={viewMode === 'list' ? 'on' : ''} onClick={() => switchView('list')}>列表</button>
        </div>
        {!online && <span className="fb-offline-hint">数据层不可用，正在重试…</span>}
        <div className="sp" />
        <ThemeToggle className="wc-btn wc-theme" />
        <WindowControls />
      </header>
      <FilterBar />
      {/* fb-main：详情抽屉 overlay 模式的定位锚（<1280px 时浮层化） */}
      <div className="fb-main flex min-h-0 flex-1">
        {viewMode === 'board' ? (
          <BoardView onCardClick={onCardClick} onContextMenu={(task, x, y) => setMenu({ task, x, y })} />
        ) : (
          <IssueListView onRowClick={onCardClick} />
        )}
        {selectedId && (
          <TaskDetailPanel taskId={selectedId} onClose={() => select(null)} />
        )}
        <OtherTasksPanel />
      </div>
      {menu && (
        <TaskContextMenu
          state={menu}
          onClose={() => setMenu(null)}
          onOpenDetail={(task) => select(task.id)}
        />
      )}
      <Toast />
    </div>
  );
}
