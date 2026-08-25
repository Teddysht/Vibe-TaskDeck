/* ============================================================
 * 附件列表 —— 上传（file input → base64 → upload_attachment）、
 * 下载（read_attachment → blob 保存）、删除。
 * 元数据来自 issue_detail 的 attachments。
 * ============================================================ */
import { useRef, useState } from 'react';
import { invoke } from '../../lib/tauri';
import { errMsg, showToast } from '../../lib/toast';
import type { Task } from '../../lib/types';
import { loadBoardData } from '../api';

export interface AttachmentMeta {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  createdAt: string;
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export default function AttachmentList({
  task,
  attachments,
  onRefresh,
}: {
  task: Task;
  attachments: AttachmentMeta[] | null;
  onRefresh: () => Promise<void>;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function upload(file: File) {
    if (file.size > 10 * 1024 * 1024) {
      showToast('附件不能超过 10MB', true);
      return;
    }
    setBusy(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = String(reader.result);
          resolve(result.slice(result.indexOf(',') + 1)); // 去 data: 前缀
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      await invoke('upload_attachment', {
        taskId: task.id,
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        base64Data: base64,
      });
      await onRefresh();
      await loadBoardData();
      showToast(`已上传 ${file.name}`);
    } catch (e) {
      showToast(errMsg(e, '上传失败'), true);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function download(att: AttachmentMeta) {
    try {
      const data = await invoke<{ filename: string; contentType: string; base64: string }>(
        'read_attachment',
        { id: att.id },
      );
      const bytes = Uint8Array.from(atob(data.base64), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: data.contentType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = data.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      showToast(errMsg(e, '读取附件失败'), true);
    }
  }

  async function remove(att: AttachmentMeta) {
    try {
      await invoke('delete_attachment', { id: att.id });
      await onRefresh();
    } catch (e) {
      showToast(errMsg(e, '删除失败'), true);
    }
  }

  if (!attachments) return null;

  return (
    <>
      <div className="d-sec">
        附件 {attachments.length > 0 ? attachments.length : ''}
        <button className="d-sec-btn" disabled={busy} onClick={() => fileRef.current?.click()}>
          上传
        </button>
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload(file);
          }}
        />
      </div>
      <div className="d-atts">
        {attachments.map((att) => (
          <div key={att.id} className="d-att">
            <span className="name" title={att.filename}>{att.filename}</span>
            <span className="size">{sizeText(att.size)}</span>
            <button title="下载" onClick={() => download(att)}>下载</button>
            <button className="danger" title="删除" onClick={() => remove(att)}>删除</button>
          </div>
        ))}
        {attachments.length === 0 && <div className="d-att-empty">暂无附件</div>}
      </div>
    </>
  );
}
