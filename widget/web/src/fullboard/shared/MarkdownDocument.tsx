/* ============================================================
 * Markdown 渲染 —— 对齐上游 MarkdownDocument（react-markdown + gfm +
 * breaks + dompurify；mermaid 不做）。描述/评论正文渲染入口。
 * ============================================================ */
import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import DOMPurify from 'dompurify';

export default function MarkdownDocument({ source }: { source: string }) {
  const clean = useMemo(() => {
    // 渲染管线内 HTML 默认不启用（react-markdown 不渲染 raw html），
    // dompurify 兜底处理未来允许 html 的场景（对齐上游双保险）
    return DOMPurify.sanitize(source ?? '');
  }, [source]);

  return (
    <div className="fb-md">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{clean}</ReactMarkdown>
    </div>
  );
}
