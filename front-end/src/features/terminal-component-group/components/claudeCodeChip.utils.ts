/**
 * Pure helpers for ClaudeCodeChip rendering — value formatters and type guards.
 * No React or DOM access here; kept side-effect free so tests can import them.
 */

import { type FilePointer, type ResponseSchemaField } from '../hooks';

/** Map a schema field type to a user-facing label (e.g. `list[str]` → `string[]`). */
export function formatFieldType(type: ResponseSchemaField['type']): string {
  switch (type) {
    case 'str':
      return 'string';
    case 'int':
      return 'integer';
    case 'float':
      return 'number';
    case 'bool':
      return 'boolean';
    case 'list[str]':
      return 'string[]';
    case 'list[int]':
      return 'integer[]';
    case 'file_pointer':
      return 'file';
    case 'list[file_pointer]':
      return 'file[]';
    default:
      return type;
  }
}

/** Narrow an unknown value to a FilePointer by checking required string fields. */
export function isFilePointer(value: unknown): value is FilePointer {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    typeof obj.storage_path === 'string' &&
    typeof obj.original_filename === 'string'
  );
}

/** Human-readable byte size (B / KB / MB). */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** snake_case → Title Case for display. */
export function humanizeFieldKey(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
