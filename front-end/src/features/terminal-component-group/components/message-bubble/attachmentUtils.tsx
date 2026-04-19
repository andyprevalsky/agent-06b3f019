/**
 * Shared helpers for rendering file attachments in MessageBubble sub-components.
 */
import { FileIcon, FileText, ImageIcon } from 'lucide-react';
import type { FilePointer } from '../../hooks';

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

/** Human-readable file size (B / KB / MB). */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
