/** Runtime validation for file pointers stored as database JSON. */
export interface FilePointer {
  id: string;
  storage_path: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
}

export function isValidFilePointer(value: unknown): value is FilePointer {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.storage_path === 'string' &&
    v.storage_path.length > 0 &&
    typeof v.mime_type === 'string' &&
    v.mime_type.length > 0 &&
    typeof v.size_bytes === 'number' &&
    Number.isFinite(v.size_bytes) &&
    v.size_bytes >= 0 &&
    typeof v.original_filename === 'string'
  );
}
