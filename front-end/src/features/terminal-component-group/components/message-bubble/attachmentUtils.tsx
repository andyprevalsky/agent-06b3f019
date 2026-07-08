/**
 * Shared helpers for rendering file attachments in MessageBubble sub-components.
 */
import { FileIcon, FileText, ImageIcon } from 'lucide-react';
import type { FilePointer } from '../../hooks';

const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdown', '.mkdn'];
const MARKDOWN_MIME_TYPES = new Set(['text/markdown', 'text/x-markdown', 'application/markdown']);

/** Pick an icon for a file based on mime-type family (image / pdf-or-text / generic). */
export function getFileIcon(fp: FilePointer) {
  if (fp.mime_type.startsWith('image/')) {
    return <ImageIcon className="w-4 h-4" />;
  }
  if (fp.mime_type === 'application/pdf' || fp.mime_type.startsWith('text/')) {
    return <FileText className="w-4 h-4" />;
  }
  return <FileIcon className="w-4 h-4" />;
}

/** True when an attachment should be fetched and rendered as inline Markdown. */
export function isMarkdownFile(fp: FilePointer): boolean {
  const filename = fp.original_filename.toLowerCase();
  return (
    MARKDOWN_MIME_TYPES.has(fp.mime_type.toLowerCase()) ||
    MARKDOWN_EXTENSIONS.some((extension) => filename.endsWith(extension))
  );
}

/** Human-readable file size (B / KB / MB). */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
