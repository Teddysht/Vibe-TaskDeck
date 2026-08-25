/* ============================================================
 * 关联编辑器 —— parent/blocks/blockedBy/related 四组展示 + 添加/移除
 * 添加：下拉选类型 + 输入目标 identifier/id（简版，对齐上游语义）
 * ============================================================ */
import { useState } from 'react';
import { invoke } from '../../lib/tauri';
import { errMsg, showToast } from '../../lib/toast';
import type { Task } from '../../lib/types';
import { loadBoardData } from '../api';

export interface RelationsView {
  parent: Array<{ id: string; identifier: string; title: string }>;
  blocks: Array<{ id: string; identifier: string; title: string }>;
  blockedBy: Array<{ id: string; identifier: string; title: string }>;
  related: Array<{ id: string; identifier: string; title: string }>;
}

const GROUP_LABEL: Record<string, string> = {
  parent: '父任务',
  blocks: '阻塞了',
  blockedBy: '被阻塞于',
  related: '相关',
};

export default function RelationsEditor({
  task,
  relations,
  onRefresh,
}: {
  task: Task;
  relations: RelationsView | null;
  onRefresh: () => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState('blocks');
  const [target, setTarget] = useState('');

  async function mutate(fn: () => Promise<unknown>) {
    try {
      await fn();
      await onRefresh();
      await loadBoardData();
    } catch (e) {
      showToast(errMsg(e, '关联操作失败'), true);
    }
  }

  async function add() {
    const value = target.trim();
    if (!value) return;
    await mutate(() =>
      invoke('add_relation', {
        id: task.id,
        version: task.version,
        relationType: kind,
        relatedTaskId: value,
      }),
    );
    setTarget('');
    setAdding(false);
  }

  if (!relations) return null;
  const entries = Object.entries(relations) as Array<[string, RelationsView['parent']]>;
  const total = entries.reduce((n, [, list]) => n + list.length, 0);

  return (
    <>
      <div className="d-sec">
        关联 {total > 0 ? total : ''}
        <button className="d-sec-btn" onClick={() => setAdding((v) => !v)}>
          {adding ? '收起' : '添加'}
        </button>
      </div>
      {adding && (
        <div className="d-rel-add">
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="parent">父任务（它是我的父）</option>
            <option value="blocks">阻塞了（我阻塞它）</option>
            <option value="blocked_by">被阻塞于（它阻塞我）</option>
            <option value="related">相关</option>
          </select>
          <input
            placeholder="目标任务 ID 或 identifier"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
          />
          <button className="primary" onClick={add}>添加</button>
        </div>
      )}
      <div className="d-rels">
        {entries.map(([group, list]) =>
          list.map((r) => (
            <div key={`${group}-${r.id}`} className="d-rel">
              <span className="kind">{GROUP_LABEL[group] ?? group}</span>
              <span className="target" title={r.title}>{r.identifier} {r.title}</span>
              <button
                title="移除关联"
                onClick={() =>
                  mutate(() =>
                    invoke('remove_relation', {
                      id: task.id,
                      version: task.version,
                      relationType: group === 'blockedBy' ? 'blocked_by' : group,
                      relatedTaskId: r.id,
                    }),
                  )
                }
              >×</button>
            </div>
          )),
        )}
        {total === 0 && <div className="d-rel-empty">暂无关联</div>}
      </div>
    </>
  );
}
