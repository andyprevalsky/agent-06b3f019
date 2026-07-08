/**
 * Renders a single attachment: image thumbnail (with loading placeholder) or
 * a downloadable non-image tile. Markdown attachments are auto-fetched by the
 * parent and rendered inline with an explicit download control.
 *
 * STATE MACHINE:
 *   image + url       -> [IMAGE THUMBNAIL]
 *   image + pending   -> [IMAGE PLACEHOLDER]
 *   markdown          -> [MD LOADING | MD READY | MD ERROR]
 *   other             -> [DOWNLOAD TILE]
 */
import { memo } from 'react';
import { Download, ImageIcon } from 'lucide-react';
import type { FilePointer } from '../../hooks';
import { getFileIcon, formatFileSize, isMarkdownFile } from './attachmentUtils';
import { MarkdownAttachmentCard } from './MarkdownAttachmentCard';
import type { MarkdownAttachmentPreview } from './useMarkdownAttachments';

interface AttachmentItemProps {
  fp: FilePointer;
  imageSrc: string;
  markdownPreview?: MarkdownAttachmentPreview;
  onOpenLightbox: (fp: FilePointer) => void;
  onDownload: (fp: FilePointer) => void;
}

export const AttachmentItem = memo(function AttachmentItem({
  fp,
  imageSrc,
  markdownPreview,
  onOpenLightbox,
  onDownload,
}: AttachmentItemProps) {
  const isImage = fp.mime_type.startsWith('image/');

  if (isImage && imageSrc) {
    return (
      <div className="relative group cursor-pointer" onClick={() => onOpenLightbox(fp)}>
        <img
          src={imageSrc}
          alt={fp.original_filename}
          className="w-60 h-60 max-w-full object-cover rounded-lg border border-border hover:border-primary transition-colors"
        />
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 rounded-lg transition-colors flex items-center justify-center">
          <span className="opacity-0 group-hover:opacity-100 text-white text-sm font-medium transition-opacity">
            View
          </span>
        </div>
      </div>
    );
  }

  if (isImage && !imageSrc && fp.storage_path) {
    return (
      <div
        className="relative group cursor-pointer w-60 h-60 max-w-full bg-muted rounded-lg border border-border hover:border-primary transition-colors flex flex-col items-center justify-center gap-2"
        onClick={() => onOpenLightbox(fp)}
      >
        <div className="animate-pulse">
          <ImageIcon className="w-12 h-12 text-muted-foreground" />
        </div>
        <span className="text-xs text-muted-foreground truncate max-w-[200px]">
          {fp.original_filename}
        </span>
      </div>
    );
  }

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
