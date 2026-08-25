/* ============================================================
 * 全版看板 App —— 顶栏 + 筛选栏 + 看板/列表视图 + 详情抽屉 + undo
 * 视图与筛选均 URL 同步（?view=list&status=…&content=…）。
 * ============================================================ */
import { useEffect, useRef, useState } from 'react';
import { invoke } from '../lib/tauri';
import { loadBoardData, markOffline } from './api';
import { useBoardEvents, useBoardPolling } from './hooks/useBoardEvents';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useBoardStore } from './store/useBoardStore';
import BoardView from './board/BoardView';
import TaskDetailPanel from './detail/TaskDetailPanel';
import IssueListView from './list/IssueListView';
import FilterBar from './filters/FilterBar';
import NewTaskPopover from './panels/NewTaskPopover';
import OtherTasksPanel from './panels/OtherTasksPanel';
import SettingsDialog, { type ReleaseInfo } from './panels/SettingsDialog';
import TaskContextMenu, { type MenuState } from './shared/TaskContextMenu';
import WindowControls from './shared/WindowControls';
import { tryGetCurrentWindow, useMaximized } from './hooks/useMaximized';
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
    // 更新检查：启动静默一次（失败零感知，不打扰）；有新版点亮齿轮徽标
    invoke<ReleaseInfo>('check_update')
      .then((r) => {
        if (r.newer) setRelease(r);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 启动一次
  }, []);

  const online = useBoardStore((s) => s.online);
  const viewMode = useBoardStore((s) => s.viewMode);
  const setViewMode = useBoardStore((s) => s.setViewMode);
  const selectedId = useBoardStore((s) => s.selectedId);
  const select = useBoardStore((s) => s.select);
  const [menu, setMenu] = useState<MenuState | null>(null);
  // 窗口最大化态：根圆角归零（贴边切不出缺口）——共享 WindowControls 同源
  const maximized = useMaximized(tryGetCurrentWindow());
  // 抽屉退出两段式：closing 态跑 120ms 反向动画（CSS fb-panel-out），
  // 动画结束才真正卸载（select(null)）。时长与 .fb-detail.closing 锚定。
  const [detailClosing, setDetailClosing] = useState(false);
  // 标题栏弹窗：新建（Popover）/ 归档（右侧 Sheet，与详情同语言）/ 设置（居中 Dialog）
  const [newOpen, setNewOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [release, setRelease] = useState<ReleaseInfo | null>(null); // 新版信息（齿轮徽标）
  const newWrapRef = useRef<HTMLDivElement>(null);
  // 归档入口计数（含隐藏时的徽标）
  const tasks = useBoardStore((s) => s.tasks);
  const archivedCount = tasks.filter((t) => t.archivedAt).length;

  // 新建 Popover 面板外点关闭；N 全局唤起（输入框聚焦时不抢占）
  useEffect(() => {
    if (!newOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!newWrapRef.current?.contains(e.target as Node)) setNewOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNewOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [newOpen]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'n' && e.key !== 'N') return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      e.preventDefault();
      setNewOpen(true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  function closeDetail() {
    if (detailClosing) return; // 防重入（closing 期间再点关闭忽略）
    setDetailClosing(true);
    window.setTimeout(() => {
      select(null);
      setDetailClosing(false);
    }, 120);
  }

  function onCardClick(task: Task) {
    if (detailClosing) setDetailClosing(false); // closing 中切换目标：立即恢复
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
    // maximized 插值前必须留空格：Tailwind 静态扫描提不出紧贴 ${ 的候选类（flex-col 曾因此丢失）
    <div className={`fb-root flex h-full flex-col ${maximized ? 'maximized' : ''}`.trim()}>
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
          <button className={viewMode === 'board' ? 'on' : ''} onClick={() => switchView('board')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><rect x="3" y="3" width="6" height="16" rx="1" /><rect x="11" y="3" width="6" height="10" rx="1" /><rect x="19" y="3" width="2" height="14" rx="1" /></svg>
            看板
          </button>
          <button className={viewMode === 'list' ? 'on' : ''} onClick={() => switchView('list')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>
            列表
          </button>
        </div>
        {!online && <span className="fb-offline-hint">数据层不可用，正在重试…</span>}
        <div className="sp" />
        <div className="fb-newwrap" ref={newWrapRef}>
          <button
            className={`fb-headerbtn${newOpen ? ' on' : ''}`}
            onClick={() => setNewOpen((v) => !v)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 12h14M12 5v14" /></svg>
            新建
          </button>
          <NewTaskPopover open={newOpen} onClose={() => setNewOpen(false)} />
        </div>
        <button
          className={`fb-headerbtn fb-archivebtn${archiveOpen ? ' on' : ''}`}
          title="归档任务"
          onClick={() => setArchiveOpen((v) => !v)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="5" rx="1" /><path d="M4 9v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9M10 13h4" /></svg>
          {archivedCount > 0 && <span className="fb-archivecount">{archivedCount}</span>}
        </button>
        <button
          className={`fb-headerbtn fb-settingsbtn${settingsOpen ? ' on' : ''}`}
          title="设置"
          aria-label="设置"
          onClick={() => setSettingsOpen((v) => !v)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
          {release?.newer && <span className="fb-settings-dot" aria-hidden="true" />}
        </button>
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
          <TaskDetailPanel taskId={selectedId} closing={detailClosing} onClose={closeDetail} />
        )}
        <OtherTasksPanel open={archiveOpen} onClose={() => setArchiveOpen(false)} />
        <SettingsDialog
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          release={release}
          onReleaseFound={setRelease}
        />
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
