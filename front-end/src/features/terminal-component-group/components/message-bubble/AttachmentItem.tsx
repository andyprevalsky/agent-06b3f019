/**
 * Renders a single non-media attachment. Images and videos never reach this
 * component — AttachmentDisplay routes them to InlineMediaGallery.
 *
 * STATE MACHINE:
 *   markdown -> [MD LOADING | MD READY | MD ERROR] (auto-fetched by the parent)
 *   other    -> [DOWNLOAD TILE]
 */
import { memo } from 'react';
import { Download } from 'lucide-react';
import type { FilePointer } from '../../hooks';
import { getFileIcon, formatFileSize, isMarkdownFile } from './attachmentUtils';
import { MarkdownAttachmentCard } from './MarkdownAttachmentCard';
import type { MarkdownAttachmentPreview } from './useMarkdownAttachments';

interface AttachmentItemProps {
  fp: FilePointer;
  markdownPreview?: MarkdownAttachmentPreview;
  onDownload: (fp: FilePointer) => void;
}

export const AttachmentItem = memo(function AttachmentItem({
  fp,
  markdownPreview,
  onDownload,
}: AttachmentItemProps) {
  if (isMarkdownFile(fp)) {
    return <MarkdownAttachmentCard fp={fp} preview={markdownPreview} onDownload={onDownload} />;
  }

  return (
    <button
      onClick={() => onDownload(fp)}
      className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-muted/50 hover:bg-muted transition-colors"
    >
      {getFileIcon(fp)}
      <div className="flex flex-col items-start">
        <span className="text-xs font-medium truncate max-w-[120px]">{fp.original_filename}</span>
        <span className="text-[10px] text-muted-foreground">{formatFileSize(fp.size_bytes)}</span>
      </div>
      <Download className="w-3 h-3 text-muted-foreground" />
    </button>
  );
});
