/**
 * DocumentPreviewDrawer — left Sheet that opens from a summary/output file chip.
 *
 * STATE MACHINE:
 * [CLOSED] --open--> [LOADING] --signed URL + body--> [READY]
 *                        |--fetch/sign fail--> [ERROR]
 * [READY|ERROR|LOADING] --onOpenChange(false)--> [CLOSED] (blob URLs revoked)
 *
 * Preview kinds:
 *   html      -> sandboxed iframe (blob URL, text/html)
 *   image     -> <img>
 *   markdown  -> MarkdownText
 *   text      -> <pre>
 *   pdf       -> iframe
 *   download  -> metadata + download only (xlsx, numbers, docx, …)
 *
 * SYSTEM CONTEXT:
 * CompletionSummaryCard / StructuredResponseDisplay -> FilePointerDisplay click
 *   -> DocumentPreviewDrawer (Sheet side=left)
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
import { documentPreviewKind, documentTypeLabel } from './documentPreview.utils';

const SIGNED_URL_TTL_SECONDS = 3600;

interface DocumentPreviewDrawerProps {
  file: FilePointer | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; downloadUrl: string; previewUrl?: string; text?: string }
  | { status: 'error'; message: string; downloadUrl?: string };

export function DocumentPreviewDrawer({ file, open, onOpenChange }: DocumentPreviewDrawerProps) {
  const [loadState, setLoadState] = useState<LoadState>({ status: 'idle' });

  useEffect(() => {
    if (!open || !file) {
      setLoadState({ status: 'idle' });
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;
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

        if (kind === 'download') {
          if (!cancelled) setLoadState({ status: 'ready', downloadUrl });
          return;
        }

        if (kind === 'text' || kind === 'markdown' || kind === 'html') {
          const text = await downloadAttachmentAsText(downloadUrl);
          if (kind === 'html') {
            objectUrl = URL.createObjectURL(
              new Blob([text], { type: 'text/html;charset=utf-8' }),
            );
            if (!cancelled) {
              setLoadState({ status: 'ready', downloadUrl, previewUrl: objectUrl });
            }
            return;
          }
          if (!cancelled) setLoadState({ status: 'ready', downloadUrl, text });
          return;
        }

        const blob = await downloadAttachmentAsBlob(downloadUrl);
        objectUrl = URL.createObjectURL(blob);
        if (!cancelled) {
          setLoadState({ status: 'ready', downloadUrl, previewUrl: objectUrl });
        }
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
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [open, file]);

  const kind = file ? documentPreviewKind(file) : 'download';
  const typeLabel = file ? documentTypeLabel(file) : 'File';

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="left"
        data-testid="document-preview-drawer"
        className={cn(
          'flex w-full max-w-xl flex-col gap-0 p-0 sm:max-w-xl',
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

        <div className="min-h-0 flex-1 overflow-auto bg-background">
          {!file ? null : loadState.status === 'loading' || loadState.status === 'idle' ? (
            <p className="p-4 text-sm text-muted-foreground" data-testid="document-preview-loading">
              Loading preview…
            </p>
          ) : loadState.status === 'error' ? (
            <p className="p-4 text-sm text-muted-foreground" data-testid="document-preview-error">
              {loadState.message}
            </p>
          ) : kind === 'html' && loadState.previewUrl ? (
            <iframe
              title={file.original_filename}
              src={loadState.previewUrl}
              sandbox="allow-scripts"
              data-testid="document-preview-html"
              className="h-full min-h-[70vh] w-full border-0 bg-white"
            />
          ) : kind === 'image' && loadState.previewUrl ? (
            <div className="flex h-full items-center justify-center p-4" data-testid="document-preview-image">
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
              <MarkdownText text={loadState.text} shouldAnimate={false} breaks className="prose-sm max-w-none" />
            </div>
          ) : kind === 'text' && loadState.text !== undefined ? (
            <pre
              data-testid="document-preview-text"
              className="whitespace-pre-wrap break-words px-4 py-4 font-mono text-xs text-foreground"
            >
              {loadState.text}
            </pre>
          ) : (
            <div
              className="flex h-full flex-col items-center justify-center gap-3 px-6 py-10 text-center"
              data-testid="document-preview-download-only"
            >
              <FileIcon className="h-10 w-10 text-muted-foreground" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">{file.original_filename}</p>
                <p className="text-xs text-muted-foreground">
                  Preview is not available for {typeLabel} files. Download to open in a compatible app.
                </p>
              </div>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
