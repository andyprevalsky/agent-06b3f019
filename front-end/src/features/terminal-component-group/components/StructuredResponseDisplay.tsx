/**
 * StructuredResponseDisplay — renders the extracted output of a completed Claude Code task.
 *
 * Stateless: receives a structured response object and an optional schema, then
 * renders each field's value via type-aware formatters (FilePointer → chip, arrays
 * → comma-joined, objects → JSON, null/undefined → em-dash).
 */

import { type ResponseSchemaField } from '../hooks';
import { FilePointerDisplay } from './FilePointerDisplay';
import { formatFieldType, humanizeFieldKey, isFilePointer } from './claudeCodeChip.utils';

function formatPrimitive(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object' && value !== null) return JSON.stringify(value, null, 2);
  if (value === null || value === undefined) return '—';
  return String(value);
}

function FieldValue({
  value,
  fieldType,
}: {
  value: unknown;
  fieldType?: ResponseSchemaField['type'];
}) {
  if (fieldType === 'file_pointer' && isFilePointer(value)) {
    return <FilePointerDisplay file={value} />;
  }

  if (fieldType === 'list[file_pointer]' && Array.isArray(value)) {
    const filePointers = value.filter(isFilePointer);
    if (filePointers.length > 0) {
      return (
        <div className="flex flex-wrap gap-1.5">
          {filePointers.map((fp) => (
            <FilePointerDisplay key={fp.id} file={fp} />
          ))}
        </div>
      );
    }
  }

  // Auto-detect FilePointer even if field type isn't specified
  if (isFilePointer(value)) {
    return <FilePointerDisplay file={value} />;
  }

  return (
    <p className="text-muted-foreground break-words whitespace-pre-wrap">
      {formatPrimitive(value)}
    </p>
  );
}

interface StructuredResponseDisplayProps {
  structuredResponse: Record<string, unknown> | undefined;
  outputSchema: { fields: ResponseSchemaField[] } | undefined;
}

export function StructuredResponseDisplay({
  structuredResponse,
  outputSchema,
}: StructuredResponseDisplayProps) {
  if (!structuredResponse || Object.keys(structuredResponse).length === 0) {
    return null;
  }

  return (
    <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
        Extracted Output
      </div>
      <div className="space-y-2">
        {Object.entries(structuredResponse).map(([key, value]) => {
          const fieldDef = outputSchema?.fields?.find((f) => f.name === key);
          return (
            <div key={key} className="text-sm">
              <div className="flex items-center gap-1.5 mb-0.5">
                <span className="font-medium text-foreground">{humanizeFieldKey(key)}</span>
                {fieldDef && (
                  <span className="text-[10px] text-muted-foreground">
                    ({formatFieldType(fieldDef.type)})
                  </span>
                )}
              </div>
              <FieldValue value={value} fieldType={fieldDef?.type} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
