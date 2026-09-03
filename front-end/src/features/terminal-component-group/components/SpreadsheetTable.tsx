/**
 * SpreadsheetTable — renders parsed rows from xlsx/csv/numbers previews.
 */
import { cn } from '@/lib/utils';

/** Cap preview render so large sheets cannot blow call-stack / main-thread. */
export const SPREADSHEET_PREVIEW_MAX_ROWS = 200;
export const SPREADSHEET_PREVIEW_MAX_COLS = 40;

interface SpreadsheetTableProps {
  rows: string[][];
  className?: string;
  /** Tighter cell padding for summary mini-previews. */
  dense?: boolean;
  testId?: string;
}

export function SpreadsheetTable({
  rows,
  className,
  dense = false,
  testId = 'document-preview-spreadsheet',
}: SpreadsheetTableProps) {
  if (rows.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">This sheet has no rows.</p>;
  }

  const previewRows = rows.slice(0, SPREADSHEET_PREVIEW_MAX_ROWS + 1).map((row) =>
    row.slice(0, SPREADSHEET_PREVIEW_MAX_COLS),
  );
  const colCount = previewRows.reduce((max, row) => Math.max(max, row.length), 1);
  const header = previewRows[0] ?? [];
  const body = previewRows.slice(1);
  const truncated = rows.length > previewRows.length || rows.some((row) => row.length > colCount);
  const thPad = dense ? 'px-1.5 py-1' : 'px-3 py-2';
  const tdPad = dense ? 'px-1.5 py-0.5' : 'px-3 py-1.5';

  return (
    <div className={cn('overflow-auto', className)} data-testid={testId}>
      <table className="min-w-full border-collapse text-left text-xs">
        <thead className="sticky top-0 bg-muted/95 backdrop-blur">
          <tr>
            {Array.from({ length: colCount }).map((_, index) => (
              <th
                key={`h-${index}`}
                className={cn('border-b border-border font-semibold text-foreground', thPad)}
              >
                {header[index] ?? ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={`r-${rowIndex}`} className="odd:bg-background even:bg-muted/30">
              {Array.from({ length: colCount }).map((_, colIndex) => (
                <td
                  key={`c-${rowIndex}-${colIndex}`}
                  className={cn(
                    'border-b border-border/60 align-top text-foreground/90',
                    tdPad,
                  )}
                >
                  {row[colIndex] ?? ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated ? (
        <p className="border-t border-border px-3 py-2 text-[10px] text-muted-foreground">
          Preview truncated — download the file for the full sheet.
        </p>
      ) : null}
    </div>
  );
}
