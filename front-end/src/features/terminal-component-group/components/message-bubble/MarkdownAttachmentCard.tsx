/**
 * Renders an auto-fetched Markdown attachment as a full-width document preview.
 *
 * STATE MACHINE:
 *   [LOADING] -> placeholder text while the preview fetch is in flight
 *   [READY]   -> static Markdown document preview with explicit download action
 *   [ERROR]   -> non-blocking preview error, download action remains available
 */
import { Download } from 'lucide-react';
import type { FilePointer } from '../../hooks';
import { MarkdownText } from '../MarkdownText';
import { formatFileSize, getFileIcon } from './attachmentUtils';
import type { MarkdownAttachmentPreview } from './useMarkdownAttachments';

interface MarkdownAttachmentCardProps {
  fp: FilePointer;
  preview?: MarkdownAttachmentPreview;
  onDownload: (fp: FilePointer) => void;
}

export function MarkdownAttachmentCard({ fp, preview, onDownload }: MarkdownAttachmentCardProps) {
  return (
    <div className="w-full rounded-lg border border-border bg-background/80 overflow-hidden">
      <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-2">
        {getFileIcon(fp)}
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">{fp.original_filename}</div>
          <div className="text-[10px] text-muted-foreground">{formatFileSize(fp.size_bytes)}</div>
        </div>
        <button
          type="button"
          aria-label={`Download ${fp.original_filename}`}
          onClick={() => onDownload(fp)}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Download className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="max-h-96 overflow-auto px-3 py-3 text-sm">
        {preview?.status === 'ready' ? (
          <MarkdownText
            text={preview.text}
            shouldAnimate={false}
            breaks
            className="prose-sm max-w-none"
          />
        ) : preview?.status === 'error' ? (
          <p className="text-xs text-muted-foreground">{preview.message}</p>
        ) : (
          <p className="text-xs text-muted-foreground">Loading preview...</p>
        )}
      </div>
    </div>
  );
}
