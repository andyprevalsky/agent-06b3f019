/**
 * FilePointerDisplay — summary/output file control; optional inline mini-preview.
 *
 * STATE MACHINE:
 * [MOUNT] --> (showMiniPreview ? [LOADING_PREVIEW] --> [PREVIEW_READY|PREVIEW_ERROR] : [CHIP])
 * [any] --click--> opens DocumentPreviewDrawer (RIGHT Sheet)
 *
 * Mini-previews are for CompletionSummaryCard only. Elsewhere this stays a compact chip.
 */

import { useState } from 'react';
import { Eye, FileIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { type FilePointer } from '../hooks';
import { formatFileSize } from './claudeCodeChip.utils';
import { DocumentMiniPreview } from './DocumentMiniPreview';
import { DocumentPreviewDrawer } from './DocumentPreviewDrawer';
import { documentTypeLabel } from './documentPreview.utils';
import { useDocumentPreview } from './useDocumentPreview';

export function FilePointerDisplay({
  file,
  showMiniPreview = false,
}: {
  file: FilePointer;
  /** Inline mini-preview — used in completion summary cards only. */
  showMiniPreview?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const typeLabel = documentTypeLabel(file);
  const miniLoadState = useDocumentPreview(file, showMiniPreview);

  return (
    <>
      <button
        type="button"
        data-testid="file-pointer-chip"
        data-filename={file.original_filename}
        data-mime={file.mime_type}
        data-mini-preview={showMiniPreview ? 'true' : 'false'}
        onClick={() => setOpen(true)}
        className={cn(
          showMiniPreview
            ? 'flex w-full max-w-md flex-col gap-2 rounded-md border border-border/60 bg-muted/40 px-2.5 py-2 text-left transition-colors hover:border-border hover:bg-muted/70'
            : 'inline-flex max-w-full items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-left text-sm text-foreground transition-colors hover:bg-muted/80',
        )}
        title={`View ${file.original_filename}`}
      >
        <div className="flex min-w-0 items-center gap-1.5">
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
          <Eye
            className={cn(
              'h-3 w-3 shrink-0 text-muted-foreground',
              showMiniPreview && 'ml-auto',
            )}
          />
        </div>
        {showMiniPreview ? (
          <DocumentMiniPreview filename={file.original_filename} loadState={miniLoadState} />
        ) : null}
      </button>
      <DocumentPreviewDrawer file={file} open={open} onOpenChange={setOpen} />
    </>
  );
}
