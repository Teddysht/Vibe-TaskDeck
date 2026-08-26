/* ============================================================
 * 大挂件 —— 头部 + 列表 + 详情覆盖层
 * （快捷看板已移除：需要多列看板时经 viewToggle 打开全版第二窗口）
 * 契约：#large 内联 display（e2e 断言 'flex'）。
 * ============================================================ */
import { useEffect, useState } from 'react';
import { closeWidget, openFullBoard } from '../lib/api';
import { errMsg, showToast } from '../lib/toast';
import { useAppStore } from '../store/useAppStore';
import CountsBar from './CountsBar';
import AutostartToggle from './AutostartToggle';
import NewTaskPanel from './NewTaskPanel';
import TaskDetail from './TaskDetail';
import TaskList from './TaskList';
import ThemeToggle from './ThemeToggle';

interface Props {
  hidden: boolean;
  entering: boolean;
  leaving: boolean;
  onCollapse: () => void;
}

export default function Large({ hidden, entering, leaving, onCollapse }: Props) {
  const projects = useAppStore((s) => s.projects);
  const tasks = useAppStore((s) => s.tasks);
  const filter = useAppStore((s) => s.filter);
  const online = useAppStore((s) => s.online);
  const largeView = useAppStore((s) => s.largeView);

  const [newPanelOpen, setNewPanelOpen] = useState(false);
  const [boardBusy, setBoardBusy] = useState(false);

  // 详情打开时收起新建面板（旧 openDetail 首行行为）
  useEffect(() => {
    if (largeView === 'detail') setNewPanelOpen(false);
  }, [largeView]);

  const proj = projects.find((p) => p.id === 'local') || projects[0];
  const rows = tasks.filter((t) => filter === 'all' || t.status === filter);
  // 空态（区分「全库为空的首启」与「该筛选下无任务」）
  const emptyShown = online && rows.length === 0;

  // 全版看板（本地页面第二窗口，纯客户端直连 SQLite；加载中转圈，失败弹 toast）
  async function onOpenFullBoard() {
    if (boardBusy) return;
    setBoardBusy(true);
    try {
      await openFullBoard();
      showToast('全版看板已打开');
    } catch (e) {
      showToast(errMsg(e, '打开失败'), true);
    } finally {
      setBoardBusy(false);
    }
  }

  const isDetail = largeView === 'detail';

  return (
    <div
      className={`large${entering ? ' entering' : ''}${leaving ? ' leaving' : ''}`}
      id="large"
      style={{ display: hidden ? 'none' : 'flex' }}
    >
      <div className="hd">
        <div className="mark">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="5" width="16" height="16" rx="3" /><path d="M8 9h8M8 13h8M8 17h5" /></svg>
        </div>
        <div>
          <div className="tt">任务看板</div>
          <div className="sub" id="projName">{proj?.name || '—'}</div>
        </div>
        <div className="sp" />
        {/* 全版看板入口（原快捷看板位；快捷看板移除后唯一看板入口）。
            图标=四角展开（挂件→全版的空间扩张；外链箭头会误读为跳转外部） */}
        <div
          className={`ic${boardBusy ? ' busy' : ''}`}
          id="viewToggle"
          title="打开全版看板（新窗口）"
          role="button"
          tabIndex={0}
          onClick={onOpenFullBoard}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6" /><path d="M9 21H3v-6" /><path d="M21 3l-7 7" /><path d="M3 21l7-7" /></svg>
        </div>
        <ThemeToggle className="ic" />
        <AutostartToggle className="ic" />
        <div className="ic" id="collapseBtn" title="收起" role="button" tabIndex={0} onClick={onCollapse}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 10l5 5 5-5" /></svg>
        </div>
        <div className="ic close" id="closeBtn" title="隐藏挂件（常驻托盘，右键托盘图标可退出）" role="button" tabIndex={0} onClick={closeWidget}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </div>
      </div>
      <CountsBar />
      <NewTaskPanel open={newPanelOpen} onClose={() => setNewPanelOpen(false)} />
      <div className="offline" id="offline" style={{ display: online ? 'none' : 'flex' }}>
        <span className="d" />数据层不可用，正在重试…
      </div>
      <TaskList />
      <div
        className={`empty${emptyShown && tasks.length === 0 ? ' actionable' : ''}`}
        id="empty"
        style={{ display: emptyShown ? 'flex' : 'none' }}
        onClick={() => setNewPanelOpen(true)}
      >
        <div className="ic">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
        </div>
        <div className="t" id="emptyT">{tasks.length === 0 ? '还没有任务' : '这个状态下还没有任务'}</div>
        <div className="s" id="emptyS">{tasks.length === 0 ? '点击这里创建第一个任务' : '试试上方的状态计数切换筛选'}</div>
      </div>
      <div className="ft">
        <button className="primary" id="newBtn" onClick={() => setNewPanelOpen((v) => !v)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          新建任务
        </button>
      </div>
      {/* 任务详情（L3-本机：详情+评论，覆盖式视图）。
          契约：#detail 常驻 DOM（旧版 display:none 切换；e2e 在未打开态也读该元素） */}
      {isDetail ? (
        <TaskDetail />
      ) : (
        <div className="detail" id="detail" style={{ display: 'none' }} />
      )}
    </div>
  );
}
