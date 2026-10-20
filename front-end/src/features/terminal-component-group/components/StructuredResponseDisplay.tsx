/**
 * StructuredResponseDisplay — renders the extracted output of a completed Claude Code task.
 *
 * Stateless: receives a structured response object and an optional schema, then
 * renders each field's value via type-aware formatters (FilePointer → chip, or
 * inline media for images/videos; several media files → one gallery strip,
 * primitive arrays → comma-joined, structured values → JSON,
 * null/undefined → em-dash).
 *
 * STATE MACHINE: Stateless. Each value renders as file, structured JSON, or text.
 */

import { type ResponseSchemaField } from '../hooks';
import { FilePointerDisplay } from './FilePointerDisplay';
import { FilePointerGroup } from './inline-media/FilePointerGroup';
import { formatFieldType, humanizeFieldKey, isFilePointer } from './claudeCodeChip.utils';

function formatPrimitive(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ');
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
    if (filePointers.length > 0) return <FilePointerGroup files={filePointers} />;
  }

  // Auto-detect FilePointer even if field type isn't specified
  if (isFilePointer(value)) {
    return <FilePointerDisplay file={value} />;
  }

  if (
    (Array.isArray(value) && value.some((item) => typeof item === 'object' && item !== null)) ||
    (!Array.isArray(value) && typeof value === 'object' && value !== null)
  ) {
    return (
      <pre className="max-h-80 overflow-auto rounded bg-muted/40 p-2 text-xs text-muted-foreground whitespace-pre-wrap break-words">
        {JSON.stringify(value, null, 2)}
      </pre>
    );
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
