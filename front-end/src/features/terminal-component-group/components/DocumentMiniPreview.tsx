/**
 * DocumentMiniPreview — compact inline preview of a loaded document payload.
 * Used inside summary FilePointerDisplay cards (not the full drawer).
 */

import { FileIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MarkdownText } from './MarkdownText';
import { SpreadsheetTable } from './SpreadsheetTable';
import type { DocumentPreviewPayload } from './documentPreview.load';
import type { DocumentPreviewLoadState } from './useDocumentPreview';

const MINI_TEXT_CHARS = 420;
const MINI_TABLE_ROWS = 4;
const MINI_TABLE_COLS = 4;

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}…`;
}

function sliceTable(rows: string[][], maxRows: number, maxCols: number): string[][] {
  return rows.slice(0, maxRows).map((row) => row.slice(0, maxCols));
}

interface DocumentMiniPreviewProps {
  filename: string;
  loadState: DocumentPreviewLoadState;
  className?: string;
}

export function DocumentMiniPreview({ filename, loadState, className }: DocumentMiniPreviewProps) {
  if (loadState.status === 'idle' || loadState.status === 'loading') {
    return (
      <div
        className={cn(
          'flex h-[7.5rem] items-center justify-center rounded-md bg-muted/40 text-xs text-muted-foreground',
          className,
        )}
        data-testid="file-pointer-mini-loading"
      >
        Loading preview…
      </div>
    );
  }

  if (loadState.status === 'error') {
    return (
      <div
        className={cn(
          'flex h-[7.5rem] items-center justify-center rounded-md bg-muted/40 px-3 text-center text-xs text-muted-foreground',
          className,
        )}
        data-testid="file-pointer-mini-error"
      >
        {loadState.message}
      </div>
    );
  }

  return (
    <div
      className={cn(
        'h-[7.5rem] overflow-hidden rounded-md border border-border/50 bg-background',
        className,
      )}
      data-testid="file-pointer-mini-preview"
      data-preview-kind={loadState.payload.kind}
    >
      <MiniBody filename={filename} payload={loadState.payload} />
    </div>
  );
}

function MiniBody({ filename, payload }: { filename: string; payload: DocumentPreviewPayload }) {
  const { kind } = payload;

  if (kind === 'html' && payload.html !== undefined) {
    return (
      <iframe
        title={`${filename} preview`}
        srcDoc={payload.html}
        sandbox=""
        data-testid="file-pointer-mini-html"
        className="pointer-events-none h-[200%] w-[200%] origin-top-left scale-50 border-0 bg-white"
        tabIndex={-1}
      />
    );
  }

  if (kind === 'image' && payload.previewUrl) {
    return (
      <div
        className="flex h-full items-center justify-center p-2"
        data-testid="file-pointer-mini-image"
      >
        <img
          src={payload.previewUrl}
          alt={filename}
          className="max-h-full max-w-full object-contain"
        />
      </div>
    );
  }

  if (kind === 'pdf' && payload.previewUrl) {
    return (
      <iframe
        title={`${filename} preview`}
        src={payload.previewUrl}
        data-testid="file-pointer-mini-pdf"
        className="pointer-events-none h-full w-full border-0"
        tabIndex={-1}
      />
    );
  }

  if (kind === 'markdown' && payload.text !== undefined) {
    return (
      <div
        className="pointer-events-none h-full overflow-hidden px-2 py-1.5 text-[10px] leading-snug"
        data-testid="file-pointer-mini-markdown"
      >
        <MarkdownText
          text={truncateText(payload.text, MINI_TEXT_CHARS)}
          shouldAnimate={false}
          breaks
          className="prose-sm max-w-none [&_*]:text-[10px] [&_*]:leading-snug"
        />
      </div>
    );
  }

  if ((kind === 'text' || kind === 'docx' || kind === 'pptx') && payload.text !== undefined) {
    return (
      <pre
        data-testid="file-pointer-mini-text"
        className="h-full overflow-hidden whitespace-pre-wrap break-words px-2 py-1.5 font-mono text-[10px] leading-snug text-foreground/90"
      >
        {truncateText(payload.text, MINI_TEXT_CHARS)}
      </pre>
    );
  }

  if (
    (kind === 'spreadsheet' || kind === 'csv' || kind === 'numbers') &&
    payload.spreadsheet &&
    payload.spreadsheet.rows.length > 0
  ) {
    return (
      <SpreadsheetTable
        rows={sliceTable(payload.spreadsheet.rows, MINI_TABLE_ROWS, MINI_TABLE_COLS)}
        className="pointer-events-none h-full"
        dense
        testId="file-pointer-mini-spreadsheet"
      />
    );
  }

  if (kind === 'numbers' && payload.previewImageUrl) {
    return (
      <div
        className="flex h-full items-center justify-center p-2"
        data-testid="file-pointer-mini-numbers-image"
      >
        <img
          src={payload.previewImageUrl}
          alt={`${filename} preview`}
          className="max-h-full max-w-full object-contain"
        />
      </div>
    );
  }

  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-1.5 px-3 text-center"
      data-testid="file-pointer-mini-download-only"
    >
      <FileIcon className="h-5 w-5 text-muted-foreground" />
      <p className="text-[10px] text-muted-foreground">Open to download</p>
    </div>
  );
}
