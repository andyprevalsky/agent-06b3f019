/**
 * FilePointerDisplay — summary/output file card with inline mini-preview.
 *
 * STATE MACHINE:
 * [MOUNT] --> [LOADING_PREVIEW] --> [PREVIEW_READY | PREVIEW_ERROR]
 * [any] --click--> opens DocumentPreviewDrawer (RIGHT Sheet)
 *
 * Drawer load/preview states live in DocumentPreviewDrawer; this card loads its
 * own lightweight preview so each file is glanceable in the completion summary.
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

export function FilePointerDisplay({ file }: { file: FilePointer }) {
  const [open, setOpen] = useState(false);
  const typeLabel = documentTypeLabel(file);
  // Eager mini-preview so summary cards show content without opening the drawer.
  const miniLoadState = useDocumentPreview(file, true);

  return (
    <>
      <button
        type="button"
        data-testid="file-pointer-chip"
        data-filename={file.original_filename}
        data-mime={file.mime_type}
        onClick={() => setOpen(true)}
        className={cn(
          'flex w-full max-w-md flex-col gap-2 rounded-md border border-border/60',
          'bg-muted/40 px-2.5 py-2 text-left transition-colors',
          'hover:border-border hover:bg-muted/70',
        )}
        title={`View ${file.original_filename}`}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <FileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium text-foreground">
            {file.original_filename}
          </span>
          <span className="shrink-0 text-[10px] text-muted-foreground">({typeLabel})</span>
          <span className="shrink-0 text-[10px] text-muted-foreground">
            ({formatFileSize(file.size_bytes)})
          </span>
          <Eye className="ml-auto h-3 w-3 shrink-0 text-muted-foreground" />
        </div>
        <DocumentMiniPreview filename={file.original_filename} loadState={miniLoadState} />
      </button>
      <DocumentPreviewDrawer file={file} open={open} onOpenChange={setOpen} />
    </>
  );
}
