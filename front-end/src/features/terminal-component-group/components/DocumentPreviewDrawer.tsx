/**
 * DocumentPreviewDrawer — RIGHT Sheet opened from a summary/output file chip.
 *
 * STATE MACHINE:
 * [CLOSED] --open--> [LOADING] --signed URL + body--> [READY]
 *                        |--fetch/sign fail--> [ERROR]
 * [READY|ERROR|LOADING] --onOpenChange(false)--> [CLOSED] (blob URLs revoked via useDocumentPreview)
 *
 * Content is mandatory for previewable types:
 *   html         -> iframe srcDoc (sandboxed, opaque origin) — always shows markup body;
 *                   Rose Desktop accounts also run its inline scripts (network still blocked)
 *   image        -> <img>
 *   video        -> <video controls> streamed from the signed URL (Rose Desktop only;
 *                   stock accounts keep videos download-only)
 *   markdown     -> MarkdownText
 *   text         -> <pre>
 *   csv          -> SpreadsheetTable
 *   pdf          -> iframe
 *   spreadsheet  -> SheetJS -> SpreadsheetTable (xlsx/xls)
 *   numbers      -> zip QuickLook/CSV or SheetJS table when readable
 *   docx         -> OOXML text extract -> <pre>
 *   pptx         -> OOXML slide text extract -> <pre>
 *   download     -> last-resort metadata (unsupported binaries only)
 *
 * SYSTEM CONTEXT:
 * CompletionSummaryCard / StructuredResponseDisplay -> FilePointerDisplay click
 *   -> DocumentPreviewDrawer (Sheet side=right)
 * InlineMediaGallery (messages, tool results, file outputs) tap/click
 *   -> DocumentPreviewDrawer (signedUrl passed through when already resolved)
 */

import { useEffect, useState } from 'react';
import { useRoseDesktop } from '@/hooks/roseDesktopContext';
import { Download, FileIcon } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { type FilePointer } from '../hooks';
import { formatFileSize } from './claudeCodeChip.utils';
import { MarkdownText } from './MarkdownText';
import { SpreadsheetTable } from './SpreadsheetTable';
import { documentPreviewKind, documentTypeLabel } from './documentPreview.utils';
import { documentPreviewFileKey, useDocumentPreview } from './useDocumentPreview';

interface DocumentPreviewDrawerProps {
  file: FilePointer | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Already-resolved signed URL; skips client-side signing when provided. */
  signedUrl?: string;
}

export function DocumentPreviewDrawer({
  file,
  open,
  onOpenChange,
  signedUrl,
}: DocumentPreviewDrawerProps) {
  // Only set after an explicit tab click. Passing the loader's default sheet back
  // into useDocumentPreview would remount the load and race blackbox assertions.
  const [selectedSheet, setSelectedSheet] = useState<string | undefined>(undefined);
  const fileKey = documentPreviewFileKey(file);
  const roseDesktop = useRoseDesktop();
  const loadState = useDocumentPreview(file, open, {
    activeSheet: selectedSheet,
    allowInlineScripts: roseDesktop,
    signedUrl,
    video: roseDesktop,
  });

  // Reset on close AND on file change. `fileKey` was already a dependency, but
  // clearing only on close meant switching files in an open drawer carried the
  // previous sheet name into the new workbook — if that name also exists there,
  // the preview silently opens on the wrong sheet.
  useEffect(() => {
    setSelectedSheet(undefined);
  }, [open, fileKey]);

  const kind = file ? documentPreviewKind(file, { video: roseDesktop }) : 'download';
  const typeLabel = file ? documentTypeLabel(file, { video: roseDesktop }) : 'File';
  const spreadsheet = loadState.status === 'ready' ? loadState.payload.spreadsheet : undefined;
  const downloadUrl =
    loadState.status === 'ready'
      ? loadState.payload.downloadUrl
      : loadState.status === 'error'
        ? loadState.downloadUrl
        : undefined;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        data-testid="document-preview-drawer"
        className={cn(
          'flex w-full max-w-2xl flex-col gap-0 p-0 sm:max-w-2xl',
          'h-full overflow-hidden',
          // Above the top-right account rail (z-[100]) so it never covers Download.
          'z-[110]',
        )}
      >
        <div className="flex items-start gap-3 border-b border-border px-4 py-4 pr-12">
          <div className="mt-0.5 rounded-md bg-muted p-2">
            <FileIcon className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <SheetTitle className="truncate text-base">
              {file?.original_filename ?? 'Document'}
            </SheetTitle>
            <SheetDescription className="mt-0.5 flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded bg-muted px-1.5 py-0.5 font-medium text-foreground/80">
                {typeLabel}
              </span>
              {file ? <span>{formatFileSize(file.size_bytes)}</span> : null}
              {file?.mime_type ? (
                <span className="truncate text-muted-foreground">{file.mime_type}</span>
              ) : null}
            </SheetDescription>
          </div>
          {downloadUrl ? (
            <a
              href={downloadUrl}
              download={file?.original_filename}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="document-preview-download"
              className={cn(
                'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border',
                'bg-background px-2.5 text-xs font-medium text-foreground hover:bg-muted',
              )}
            >
              <Download className="h-3.5 w-3.5" />
              Download
            </a>
          ) : null}
        </div>

        {spreadsheet && spreadsheet.sheetNames.length > 1 ? (
          <div className="flex gap-1 overflow-x-auto border-b border-border px-3 py-2">
            {spreadsheet.sheetNames.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => setSelectedSheet(name)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                  name === spreadsheet.activeSheet
                    ? 'bg-foreground text-background'
                    : 'bg-muted text-muted-foreground hover:text-foreground',
                )}
              >
                {name}
              </button>
            ))}
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-auto bg-background">
          {!file ? null : loadState.status === 'loading' || loadState.status === 'idle' ? (
            <p className="p-4 text-sm text-muted-foreground" data-testid="document-preview-loading">
              Loading preview…
            </p>
          ) : loadState.status === 'error' ? (
            <p className="p-4 text-sm text-muted-foreground" data-testid="document-preview-error">
              {loadState.message}
            </p>
          ) : kind === 'html' && loadState.payload.html !== undefined ? (
            <iframe
              title={file.original_filename}
              srcDoc={loadState.payload.html}
              // Scripts allowed; opaque origin (no allow-same-origin) so agent HTML
              // cannot touch parent localStorage / authenticated same-origin APIs.
              sandbox="allow-scripts"
              data-testid="document-preview-html"
              className="h-full min-h-[70vh] w-full border-0 bg-white"
            />
          ) : kind === 'image' && loadState.payload.previewUrl ? (
            <div
              className="flex h-full items-center justify-center p-4"
              data-testid="document-preview-image"
            >
              <img
                src={loadState.payload.previewUrl}
                alt={file.original_filename}
                className="max-h-full max-w-full object-contain"
              />
            </div>
          ) : kind === 'video' && loadState.payload.previewUrl ? (
            <div className="flex h-full items-center justify-center bg-black p-4">
              <video
                src={loadState.payload.previewUrl}
                controls
                playsInline
                data-testid="document-preview-video"
                className="max-h-full max-w-full"
              />
            </div>
          ) : kind === 'pdf' && loadState.payload.previewUrl ? (
            <iframe
              title={file.original_filename}
              src={loadState.payload.previewUrl}
              data-testid="document-preview-pdf"
              className="h-full min-h-[70vh] w-full border-0"
            />
          ) : kind === 'markdown' && loadState.payload.text !== undefined ? (
            <div className="px-4 py-4 text-sm" data-testid="document-preview-markdown">
              <MarkdownText
                text={loadState.payload.text}
                shouldAnimate={false}
                breaks
                className="prose-sm max-w-none"
              />
            </div>
          ) : (kind === 'text' || kind === 'docx' || kind === 'pptx') &&
            loadState.payload.text !== undefined ? (
            <pre
              data-testid="document-preview-text"
              className="whitespace-pre-wrap break-words px-4 py-4 font-mono text-xs text-foreground"
            >
              {loadState.payload.text}
            </pre>
          ) : (kind === 'spreadsheet' || kind === 'csv' || kind === 'numbers') &&
            spreadsheet &&
            spreadsheet.rows.length > 0 ? (
            <SpreadsheetTable rows={spreadsheet.rows} className="h-full" />
          ) : kind === 'numbers' && loadState.payload.previewImageUrl ? (
            <div
              className="flex h-full items-center justify-center p-4"
              data-testid="document-preview-numbers-image"
            >
              <img
                src={loadState.payload.previewImageUrl}
                alt={`${file.original_filename} preview`}
                className="max-h-full max-w-full object-contain"
              />
            </div>
          ) : kind === 'numbers' || kind === 'spreadsheet' || kind === 'csv' ? (
            <p className="p-4 text-sm text-muted-foreground" data-testid="document-preview-empty">
              No previewable rows in this document. Download to open in a spreadsheet app.
            </p>
          ) : (
            <div
              className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center"
              data-testid="document-preview-download-only"
            >
              <FileIcon className="h-10 w-10 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                Preview is not available for this file type. Use Download to open it locally.
              </p>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
