/* ============================================================
 * 设置弹窗 —— 全版看板顶栏齿轮入口，界面居中 Dialog（shadcn 口径）。
 * 分组：通用（开机自启 Switch）· AI 接入（Claude Code / Codex 一键
 * 安装 skill，v0.5.2）· 关于（版本号 + 检查更新）。
 * 更新检查：手动按钮 + 启动静默一次；有新版时齿轮挂小圆点徽标
 * （徽标态由父组件 App 持有，经 props 传入 release）。
 * 失败静默原则：网络失败不弹错误 toast（手动点击给出弱提示行）；
 * detect_agents 失败整组不展示（mock 环境无此命令即隐身）。
 * ============================================================ */
import { useEffect, useRef, useState } from 'react';
import { invoke } from '../../lib/tauri';
import { showToast } from '../../lib/toast';
import { useExitAnimation } from '../hooks/useExitAnimation';

export interface ReleaseInfo {
  tag: string;
  name: string;
  notes: string;
  url: string;
  newer: boolean;
}

/** 「AI 接入」组：detect_agents 返回的 agent 状态 */
export interface AgentInfo {
  id: string;
  name: string;
  agentInstalled: boolean;
  installed: boolean;
  version: string | null;
}

type CheckState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'latest'; tag: string }
  | { kind: 'available'; release: ReleaseInfo }
  | { kind: 'failed' };

export default function SettingsDialog({
  open,
  onClose,
  release,          // 启动静默检查的已有结果（新版则直接展示）
  onReleaseFound,   // 通知 App 点亮齿轮徽标
}: {
  open: boolean;
  onClose: () => void;
  release: ReleaseInfo | null;
  onReleaseFound: (r: ReleaseInfo) => void;
}) {
  const [version, setVersion] = useState('');
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [check, setCheck] = useState<CheckState>({ kind: 'idle' });
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [installing, setInstalling] = useState<string | null>(null); // agent id
  const dialogRef = useRef<HTMLDivElement>(null);
  // 退出与详情抽屉同语言：closing 120ms 后卸载（overlay + dialog 同步退出）
  const { mounted, closing } = useExitAnimation(open);

  // 打开时拉版本 + 自启态；静默检查已有结果则直接呈现
  useEffect(() => {
    if (!open) return;
    invoke<string>('get_app_version').then(setVersion).catch(() => setVersion('—'));
    invoke<boolean>('plugin:autostart|is_enabled')
      .then(setAutostart)
      .catch(() => setAutostart(null));
    if (release?.newer) setCheck({ kind: 'available', release });
    else setCheck({ kind: 'idle' });
    // AI agent 接入状态（检测失败静默——组不展示，不打扰）
    invoke<AgentInfo[]>('detect_agents').then(setAgents).catch(() => setAgents([]));
  }, [open, release]);

  // Esc 关闭（输入框聚焦时也生效——设置弹窗内没有需要 Esc 退出的编辑态）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  async function toggleAutostart(on: boolean) {
    const prev = autostart;
    setAutostart(on); // 乐观更新
    try {
      await invoke(`plugin:autostart|${on ? 'enable' : 'disable'}`);
    } catch (e) {
      setAutostart(prev); // 回滚
      showToast('设置开机自启失败', true);
    }
  }

  async function doCheck() {
    setCheck({ kind: 'checking' });
    try {
      const r = await invoke<ReleaseInfo>('check_update');
      if (r.newer) {
        setCheck({ kind: 'available', release: r });
        onReleaseFound(r); // 点亮齿轮徽标
      } else {
        setCheck({ kind: 'latest', tag: r.tag });
      }
    } catch {
      setCheck({ kind: 'failed' });
    }
  }

  async function goDownload(url: string) {
    try {
      await invoke('open_release_page', { url });
    } catch {
      showToast('打开浏览器失败', true);
    }
  }

  async function doInstall(agent: AgentInfo) {
    setInstalling(agent.id);
    try {
      const r = await invoke<{ updated: boolean; version: string }>('install_skill', { agent: agent.id });
      // 就地更新列表状态（无需重新 detect）
      setAgents((prev) => prev.map((a) => (a.id === agent.id ? { ...a, installed: true, version: r.version } : a)));
      showToast(r.updated ? `已更新 ${agent.name} 的 skill（v${r.version}）` : `已安装到 ${agent.name}（v${r.version}），AI 重启会话后生效`);
    } catch (e) {
      showToast(`安装失败：${String(e)}`, true);
    } finally {
      setInstalling(null);
    }
  }

  if (!mounted) return null;

  return (
    <div
      className={`fb-dialog-overlay${closing ? ' closing' : ''}`}
      onMouseDown={(e) => {
        if (!dialogRef.current?.contains(e.target as Node)) onClose();
      }}
    >
      <div className={`fb-dialog${closing ? ' closing' : ''}`} ref={dialogRef} role="dialog" aria-modal="true" aria-label="设置">
        <header className="fb-dialog-hd">
          <span className="t">设置</span>
          <span className="sp" />
          <button className="d-close" title="关闭（Esc）" aria-label="关闭设置" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </header>

        <div className="fb-dialog-body">
          {/* ---- 通用 ---- */}
          <div className="fb-set-group">
            <div className="fb-set-title">通用</div>
            <div className="fb-set-row">
              <div className="fb-set-label">
                <div className="n">开机自启</div>
                <div className="s">登录 Windows 后自动启动挂件</div>
              </div>
              {/* shadcn Switch：轨道+滑块，选中染 primary */}
              <button
                className={`fb-switch${autostart ? ' on' : ''}`}
                role="switch"
                aria-checked={autostart ?? false}
                disabled={autostart === null}
                title={autostart === null ? '不可用' : autostart ? '点击关闭' : '点击开启'}
                onClick={() => toggleAutostart(!autostart)}
              >
                <span className="knob" />
              </button>
            </div>
          </div>

          {/* ---- AI 接入 ---- */}
          {agents.length > 0 && (
            <div className="fb-set-group">
              <div className="fb-set-title">AI 接入</div>
              {agents.map((agent) => (
                <div className="fb-set-row" key={agent.id} data-agent-row={agent.id}>
                  <div className="fb-set-label">
                    <div className="n">{agent.name}</div>
                    <div className="s">
                      {!agent.agentInstalled
                        ? '未检测到该 agent（安装后可用）'
                        : agent.installed
                          ? `已安装${agent.version ? ` v${agent.version}` : ''} · 与挂件同库`
                          : '安装本 skill 到其 skills 目录'}
                    </div>
                  </div>
                  <button
                    className="fb-set-checkbtn"
                    disabled={!agent.agentInstalled || installing !== null}
                    onClick={() => doInstall(agent)}
                    data-agent-action={agent.id}
                  >
                    {installing === agent.id ? '安装中…' : agent.installed ? '更新' : '安装'}
                  </button>
                </div>
              ))}
              <div className="fb-set-note">安装后 AI 重启会话即可用 taskctl 操作同一块看板；更新会同步最新 skill 协议</div>
            </div>
          )}

          {/* ---- 关于 ---- */}
          <div className="fb-set-group">
            <div className="fb-set-title">关于</div>
            <div className="fb-set-row">
              <div className="fb-set-label">
                <div className="n">版本</div>
                <div className="s">Vibe-TaskDeck v{version}</div>
              </div>
              <button
                className="fb-set-checkbtn"
                disabled={check.kind === 'checking'}
                onClick={doCheck}
              >
                {check.kind === 'checking' ? '检查中…' : '检查更新'}
              </button>
            </div>
            {/* 检查结果行（弱提示，不弹窗） */}
            {check.kind === 'latest' && (
              <div className="fb-set-note">已是最新版本（{check.tag}）</div>
            )}
            {check.kind === 'failed' && (
              <div className="fb-set-note err">检查失败，请稍后重试（需要网络）</div>
            )}
            {check.kind === 'available' && (
              <div className="fb-set-update">
                <div className="hd">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg>
                  发现新版本 {check.release.tag}
                </div>
                {check.release.notes && (
                  <div className="notes">{check.release.notes.split('\n').slice(0, 6).join('\n')}</div>
                )}
                <button className="fb-set-goto" onClick={() => goDownload(check.release.url)}>
                  前往下载
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 17 17 7M8 7h9v9" /></svg>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
