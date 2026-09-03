/**
 * SpreadsheetTable — renders parsed rows from xlsx/csv/numbers previews.
 */
import { cn } from '@/lib/utils';

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

  const colCount = Math.max(...rows.map((row) => row.length), 1);
  const header = rows[0] ?? [];
  const body = rows.slice(1);
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
    </div>
  );
}
