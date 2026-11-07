/**
 * Markdown <table> inside its own horizontal scroll container, so a wide table
 * scrolls instead of squeezing its columns or overflowing the transcript.
 */
import type { ReactNode } from 'react';

export function MarkdownTable({ children }: { children?: ReactNode }) {
  return (
    <div className="markdown-table-scroll" data-markdown-table-scroll="">
      <table>{children}</table>
    </div>
  );
}
