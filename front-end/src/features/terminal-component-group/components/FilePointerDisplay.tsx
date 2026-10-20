/**
 * FilePointerDisplay — summary/output file control; optional inline mini-preview.
 *
 * STATE MACHINE:
 * [MOUNT] --Rose Desktop + image/video--> [INLINE MEDIA] (InlineMediaGallery; no chip,
 *                                          no click needed; tap opens the drawer)
 * [MOUNT] --otherwise (stock: every file)--> (showMiniPreview ? [LOADING_PREVIEW] -->
 *                                          [PREVIEW_READY|PREVIEW_ERROR] : [CHIP])
 * [any] --click--> opens DocumentPreviewDrawer (RIGHT Sheet)
 *
 * Mini-previews are for CompletionSummaryCard only. Elsewhere this stays a compact chip.
 * The mini-preview is a sibling of the button (never nested interactive content).
 */

import { useState } from 'react';
import { Eye, FileIcon } from 'lucide-react';
import { useRoseDesktop } from '@/hooks/roseDesktopContext';
import { cn } from '@/lib/utils';
import { type FilePointer } from '../hooks';
import { formatFileSize } from './claudeCodeChip.utils';
import { DocumentMiniPreview } from './DocumentMiniPreview';
import { DocumentPreviewDrawer } from './DocumentPreviewDrawer';
import { documentTypeLabel } from './documentPreview.utils';
import { useDocumentPreview } from './useDocumentPreview';
import { InlineMediaGallery } from './inline-media/InlineMediaGallery';
import { isInlineMedia } from './inline-media/inlineMedia.utils';

export function FilePointerDisplay({
  file,
  showMiniPreview = false,
}: {
  file: FilePointer;
  /** Inline mini-preview — used in completion summary cards only. */
  showMiniPreview?: boolean;
}) {
  const roseDesktop = useRoseDesktop();
  if (roseDesktop && isInlineMedia(file)) return <InlineMediaGallery files={[file]} />;
  return <FilePointerChip file={file} showMiniPreview={showMiniPreview} />;
}

function FilePointerChip({ file, showMiniPreview }: { file: FilePointer; showMiniPreview: boolean }) {
  const [open, setOpen] = useState(false);
  const typeLabel = documentTypeLabel(file);
  const miniLoadState = useDocumentPreview(file, showMiniPreview);

  const header = (
    <>
      <FileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span
        className={cn(
          'truncate',
          showMiniPreview ? 'text-sm font-medium text-foreground' : 'max-w-[200px]',
        )}
      >
        {file.original_filename}
      </span>
      <span className="shrink-0 text-[10px] text-muted-foreground">({typeLabel})</span>
      <span className="shrink-0 text-[10px] text-muted-foreground">
        ({formatFileSize(file.size_bytes)})
      </span>
      <Eye className={cn('h-3 w-3 shrink-0 text-muted-foreground', showMiniPreview && 'ml-auto')} />
    </>
  );

  return (
    <>
      {showMiniPreview ? (
        <div
          className="flex w-full max-w-md flex-col gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-2 text-left shadow-sm transition-[border-color,background-color,box-shadow] hover:border-foreground/25 hover:bg-muted/70 hover:shadow-md"
          data-testid="file-pointer-chip-wrap"
        >
          <button
            type="button"
            data-testid="file-pointer-chip"
            data-filename={file.original_filename}
            data-mime={file.mime_type}
            data-mini-preview="true"
            onClick={() => setOpen(true)}
            className="flex min-w-0 items-center gap-1.5 text-left"
            title={`View ${file.original_filename}`}
          >
            {header}
          </button>
          <button
            type="button"
            data-testid="file-pointer-mini-hit"
            onClick={() => setOpen(true)}
            className="w-full text-left"
            title={`View ${file.original_filename}`}
          >
            <DocumentMiniPreview filename={file.original_filename} loadState={miniLoadState} />
          </button>
        </div>
      ) : (
        <button
          type="button"
          data-testid="file-pointer-chip"
          data-filename={file.original_filename}
          data-mime={file.mime_type}
          data-mini-preview="false"
          onClick={() => setOpen(true)}
          className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-left text-sm text-foreground transition-colors hover:bg-muted/80"
          title={`View ${file.original_filename}`}
        >
          {header}
        </button>
      )}
      <DocumentPreviewDrawer file={file} open={open} onOpenChange={setOpen} />
    </>
  );
}
