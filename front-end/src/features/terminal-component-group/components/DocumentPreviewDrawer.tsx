/**
 * DocumentPreviewDrawer — RIGHT Sheet opened from a summary/output file chip.
 *
 * STATE MACHINE:
 * [CLOSED] --open--> [LOADING] --signed URL + body--> [READY]
 *                        |--fetch/sign fail--> [ERROR]
 * [READY|ERROR|LOADING] --onOpenChange(false)--> [CLOSED] (blob URLs revoked)
 *
 * Content is mandatory for previewable types:
 *   html         -> iframe srcDoc (sandboxed) — always shows markup body
 *   image        -> <img>
 *   markdown     -> MarkdownText
 *   text         -> <pre>
 *   csv          -> SpreadsheetTable
 *   pdf          -> iframe
 *   spreadsheet  -> SheetJS -> SpreadsheetTable (xlsx/xls)
 *   numbers      -> zip QuickLook/CSV or SheetJS table when readable
 *   download     -> last-resort metadata (unsupported binaries only)
 *
 * SYSTEM CONTEXT:
 * CompletionSummaryCard / StructuredResponseDisplay -> FilePointerDisplay click
 *   -> DocumentPreviewDrawer (Sheet side=right)
 */

import { useEffect, useState } from 'react';
import { Download, FileIcon } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabase';
import { downloadAttachmentAsBlob, downloadAttachmentAsText, type FilePointer } from '../hooks';
import { formatFileSize } from './claudeCodeChip.utils';
import { MarkdownText } from './MarkdownText';
import { SpreadsheetTable } from './SpreadsheetTable';
import {
  documentPreviewKind,
  documentTypeLabel,
  parseDelimitedTable,
  parseNumbersPackage,
  parseSpreadsheetBytes,
  type SpreadsheetPreview,
} from './documentPreview.utils';


async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer();
  }
  // jsdom Blobs may lack arrayBuffer()/stream(); FileReader works in tests + browsers.
  return await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read blob'));
    reader.readAsArrayBuffer(blob);
  });
}

const SIGNED_URL_TTL_SECONDS = 3600;

interface DocumentPreviewDrawerProps {
  file: FilePointer | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | {
      status: 'ready';
      downloadUrl: string;
      previewUrl?: string;
      html?: string;
      text?: string;
      spreadsheet?: SpreadsheetPreview;
      previewImageUrl?: string;
    }
  | { status: 'error'; message: string; downloadUrl?: string };

export function DocumentPreviewDrawer({ file, open, onOpenChange }: DocumentPreviewDrawerProps) {
  const [loadState, setLoadState] = useState<LoadState>({ status: 'idle' });
  const [activeSheet, setActiveSheet] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!open || !file) {
      setLoadState({ status: 'idle' });
      setActiveSheet(undefined);
      return;
    }

    let cancelled = false;
    const objectUrls: string[] = [];
    const kind = documentPreviewKind(file);

    setLoadState({ status: 'loading' });

    async function load() {
      try {
        const { data, error } = await supabase.storage
          .from('attachments')
          .createSignedUrl(file!.storage_path, SIGNED_URL_TTL_SECONDS);
        if (error || !data?.signedUrl) {
          throw new Error(error?.message || 'Could not create signed URL');
        }
        const downloadUrl = data.signedUrl;

        if (kind === 'html') {
          const html = await downloadAttachmentAsText(downloadUrl);
          if (!cancelled) setLoadState({ status: 'ready', downloadUrl, html });
          return;
        }

        if (kind === 'text' || kind === 'markdown') {
          const text = await downloadAttachmentAsText(downloadUrl);
          if (!cancelled) setLoadState({ status: 'ready', downloadUrl, text });
          return;
        }

        if (kind === 'csv') {
          const text = await downloadAttachmentAsText(downloadUrl);
          const delimiter = file!.original_filename.toLowerCase().endsWith('.tsv') ? '\t' : ',';
          const rows = parseDelimitedTable(text, delimiter);
          if (!cancelled) {
            setLoadState({
              status: 'ready',
              downloadUrl,
              text,
              spreadsheet: { sheetNames: ['Sheet1'], activeSheet: 'Sheet1', rows },
            });
          }
          return;
        }

        if (kind === 'spreadsheet') {
          const blob = await downloadAttachmentAsBlob(downloadUrl);
          const spreadsheet = await parseSpreadsheetBytes(await blobToArrayBuffer(blob), activeSheet);
          if (!cancelled) {
            setActiveSheet(spreadsheet.activeSheet);
            setLoadState({ status: 'ready', downloadUrl, spreadsheet });
          }
          return;
        }

        if (kind === 'numbers') {
          const blob = await downloadAttachmentAsBlob(downloadUrl);
          const parsed = await parseNumbersPackage(await blobToArrayBuffer(blob));
          if (parsed.previewImageUrl) objectUrls.push(parsed.previewImageUrl);
          if (!cancelled) {
            if (parsed.spreadsheet) setActiveSheet(parsed.spreadsheet.activeSheet);
            setLoadState({
              status: 'ready',
              downloadUrl,
              spreadsheet: parsed.spreadsheet,
              previewImageUrl: parsed.previewImageUrl,
              text: parsed.text,
            });
          }
          return;
        }

        if (kind === 'download') {
          if (!cancelled) setLoadState({ status: 'ready', downloadUrl });
          return;
        }

        const blob = await downloadAttachmentAsBlob(downloadUrl);
        const previewUrl = URL.createObjectURL(blob);
        objectUrls.push(previewUrl);
        if (!cancelled) setLoadState({ status: 'ready', downloadUrl, previewUrl });
      } catch (err) {
        if (cancelled) return;
        setLoadState({
          status: 'error',
          message: err instanceof Error ? err.message : 'Failed to load document',
        });
      }
    }

    void load();

    return () => {
      cancelled = true;
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [open, file]);

  const readyDownloadUrl = loadState.status === 'ready' ? loadState.downloadUrl : undefined;
  const loadedSheetName =
    loadState.status === 'ready' ? loadState.spreadsheet?.activeSheet : undefined;

  useEffect(() => {
    if (!open || !file || documentPreviewKind(file) !== 'spreadsheet') return;
    if (!activeSheet || !readyDownloadUrl || loadedSheetName === activeSheet) return;

    let cancelled = false;
    async function reloadSheet() {
      try {
        const blob = await downloadAttachmentAsBlob(readyDownloadUrl!);
        const spreadsheet = await parseSpreadsheetBytes(await blobToArrayBuffer(blob), activeSheet);
        if (!cancelled) {
          setLoadState({ status: 'ready', downloadUrl: readyDownloadUrl!, spreadsheet });
        }
      } catch {
        // keep prior sheet visible
      }
    }
    void reloadSheet();
    return () => {
      cancelled = true;
    };
  }, [activeSheet, file, open, readyDownloadUrl, loadedSheetName]);

  const kind = file ? documentPreviewKind(file) : 'download';
  const typeLabel = file ? documentTypeLabel(file) : 'File';
  const spreadsheet = loadState.status === 'ready' ? loadState.spreadsheet : undefined;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        data-testid="document-preview-drawer"
        className={cn(
          'flex w-full max-w-2xl flex-col gap-0 p-0 sm:max-w-2xl',
          'h-full overflow-hidden',
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
          {loadState.status === 'ready' && loadState.downloadUrl ? (
            <a
              href={loadState.downloadUrl}
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
                onClick={() => setActiveSheet(name)}
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
          ) : kind === 'html' && loadState.html !== undefined ? (
            <iframe
              title={file.original_filename}
              srcDoc={loadState.html}
              sandbox="allow-scripts allow-same-origin"
              data-testid="document-preview-html"
              className="h-full min-h-[70vh] w-full border-0 bg-white"
            />
          ) : kind === 'image' && loadState.previewUrl ? (
            <div
              className="flex h-full items-center justify-center p-4"
              data-testid="document-preview-image"
            >
              <img
                src={loadState.previewUrl}
                alt={file.original_filename}
                className="max-h-full max-w-full object-contain"
              />
            </div>
          ) : kind === 'pdf' && loadState.previewUrl ? (
            <iframe
              title={file.original_filename}
              src={loadState.previewUrl}
              data-testid="document-preview-pdf"
              className="h-full min-h-[70vh] w-full border-0"
            />
          ) : kind === 'markdown' && loadState.text !== undefined ? (
            <div className="px-4 py-4 text-sm" data-testid="document-preview-markdown">
              <MarkdownText
                text={loadState.text}
                shouldAnimate={false}
                breaks
                className="prose-sm max-w-none"
              />
            </div>
          ) : kind === 'text' && loadState.text !== undefined ? (
            <pre
              data-testid="document-preview-text"
              className="whitespace-pre-wrap break-words px-4 py-4 font-mono text-xs text-foreground"
            >
              {loadState.text}
            </pre>
          ) : (kind === 'spreadsheet' || kind === 'csv' || kind === 'numbers') && spreadsheet ? (
            <SpreadsheetTable rows={spreadsheet.rows} className="h-full" />
          ) : kind === 'numbers' && loadState.previewImageUrl ? (
            <div
              className="flex h-full items-center justify-center p-4"
              data-testid="document-preview-numbers-image"
            >
              <img
                src={loadState.previewImageUrl}
                alt={`${file.original_filename} preview`}
                className="max-h-full max-w-full object-contain"
              />
            </div>
          ) : kind === 'numbers' || kind === 'spreadsheet' || kind === 'csv' ? (
            <p className="p-4 text-sm text-muted-foreground" data-testid="document-preview-error">
              Could not extract readable contents from this file.
            </p>
          ) : (
            <div
              className="flex h-full flex-col items-center justify-center gap-3 px-6 py-10 text-center"
              data-testid="document-preview-download-only"
            >
              <FileIcon className="h-10 w-10 text-muted-foreground" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">{file.original_filename}</p>
                <p className="text-xs text-muted-foreground">
                  No in-app content renderer for {typeLabel} yet. Download to open the file.
                </p>
              </div>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
