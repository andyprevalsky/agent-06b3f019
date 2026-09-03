/**
 * FilePointerDisplay — clickable chip for a FilePointer in summary/structured output.
 *
 * STATE MACHINE:
 * [CHIP] --click--> opens DocumentPreviewDrawer (RIGHT Sheet)
 * Drawer load/preview states live in DocumentPreviewDrawer.
 *
 * Any mime type is supported (xlsx, numbers, html, pdf, …). Previewable types
 * (html/xlsx/csv/pdf/images/text/numbers-with-embedded-csv) render file contents
 * inside the drawer.
 */

import { useState } from 'react';
import { FileIcon, Eye } from 'lucide-react';
import { cn } from '@/lib/utils';
import { type FilePointer } from '../hooks';
import { formatFileSize } from './claudeCodeChip.utils';
import { DocumentPreviewDrawer } from './DocumentPreviewDrawer';
import { documentTypeLabel } from './documentPreview.utils';

export function FilePointerDisplay({ file }: { file: FilePointer }) {
  const [open, setOpen] = useState(false);
  const typeLabel = documentTypeLabel(file);

  return (
    <>
      <button
        type="button"
        data-testid="file-pointer-chip"
        data-filename={file.original_filename}
        data-mime={file.mime_type}
        onClick={() => setOpen(true)}
        className={cn(
          'inline-flex max-w-full items-center gap-1.5 rounded-md px-2 py-1',
          'bg-muted hover:bg-muted/80 transition-colors',
          'text-sm text-foreground text-left',
        )}
        title={`View ${file.original_filename}`}
      >
        <FileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate max-w-[200px]">{file.original_filename}</span>
        <span className="shrink-0 text-[10px] text-muted-foreground">({typeLabel})</span>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          ({formatFileSize(file.size_bytes)})
        </span>
        <Eye className="h-3 w-3 shrink-0 text-muted-foreground" />
      </button>
      <DocumentPreviewDrawer file={file} open={open} onOpenChange={setOpen} />
    </>
  );
}
