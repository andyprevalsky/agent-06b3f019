/**
 * SpreadsheetTable — renders parsed rows from xlsx/csv/numbers previews.
 */
import { cn } from '@/lib/utils';

interface SpreadsheetTableProps {
  rows: string[][];
  className?: string;
}

export function SpreadsheetTable({ rows, className }: SpreadsheetTableProps) {
  if (rows.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">This sheet has no rows.</p>;
  }

  const colCount = Math.max(...rows.map((row) => row.length), 1);
  const header = rows[0] ?? [];
  const body = rows.slice(1);

  return (
    <div className={cn('overflow-auto', className)} data-testid="document-preview-spreadsheet">
      <table className="min-w-full border-collapse text-left text-xs">
        <thead className="sticky top-0 bg-muted/95 backdrop-blur">
          <tr>
            {Array.from({ length: colCount }).map((_, index) => (
              <th
                key={`h-${index}`}
                className="border-b border-border px-3 py-2 font-semibold text-foreground"
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
                  className="border-b border-border/60 px-3 py-1.5 align-top text-foreground/90"
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
