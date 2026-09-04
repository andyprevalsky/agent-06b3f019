import type { FilePointer } from './storage';

export function isFilePointer(value: unknown): value is FilePointer {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<FilePointer>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.storage_path === 'string' &&
    typeof candidate.original_filename === 'string' &&
    typeof candidate.mime_type === 'string' &&
    typeof candidate.size_bytes === 'number' &&
    typeof candidate.created_at === 'string'
  );
}
