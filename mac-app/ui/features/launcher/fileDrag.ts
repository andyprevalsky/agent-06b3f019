/**
 * File-drag detection helpers for the quick launcher.
 *
 * On macOS, Finder / screenshot-thumbnail drags often omit the literal
 * `Files` type during `dragover`/`dragenter` and only populate `files` on
 * `drop`. Gate acceptance on a broader type set so we still call
 * `preventDefault()` and claim the drop (otherwise Electron lets the drop
 * fall through the transparent always-on-top window onto apps behind).
 *
 * Drop extraction is separate: screenshot drops frequently leave
 * `dataTransfer.files` empty and only expose the File via `items.getAsFile()`
 * or a `text/uri-list` / `public.file-url` entry.
 */

const FILE_DRAG_TYPES = new Set([
  'Files',
  'files',
  'text/uri-list',
  'public.file-url',
  'application/x-moz-file',
]);

export function looksLikeFileDrag(dataTransfer: DataTransfer | null | undefined): boolean {
  if (dataTransfer === null || dataTransfer === undefined) return false;

  const types = Array.from(dataTransfer.types ?? []);
  if (types.some((type) => FILE_DRAG_TYPES.has(type))) return true;
  if (types.some((type) => type.toLowerCase().includes('file'))) return true;

  const items = dataTransfer.items;
  if (items !== null && items !== undefined) {
    for (let i = 0; i < items.length; i += 1) {
      if (items[i]?.kind === 'file') return true;
    }
  }

  return (dataTransfer.files?.length ?? 0) > 0;
}

/** Collect dropped files from every pasteboard surface macOS may populate. */
export function extractDroppedFiles(dataTransfer: DataTransfer | null | undefined): File[] {
  if (dataTransfer === null || dataTransfer === undefined) return [];

  const fromFiles = Array.from(dataTransfer.files ?? []);
  if (fromFiles.length > 0) return fromFiles;

  const fromItems: File[] = [];
  const items = dataTransfer.items;
  if (items !== null && items !== undefined) {
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item === undefined || item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (file !== null) fromItems.push(file);
    }
  }
  if (fromItems.length > 0) return fromItems;

  return [];
}

/**
 * Resolve file:// URIs advertised on drop when File objects are unavailable.
 * Used for macOS screenshot / Finder promised-file pasteboards.
 */
export async function extractDroppedFilesAsync(
  dataTransfer: DataTransfer | null | undefined
): Promise<File[]> {
  const sync = extractDroppedFiles(dataTransfer);
  if (sync.length > 0) return sync;
  if (dataTransfer === null || dataTransfer === undefined) return [];

  const uriList = readUriList(dataTransfer);
  if (uriList.length === 0) return [];

  const files: File[] = [];
  for (const uri of uriList) {
    if (!uri.startsWith('file:')) continue;
    try {
      const response = await fetch(uri);
      if (!response.ok) continue;
      const blob = await response.blob();
      const name = decodeURIComponent(uri.split('/').pop() ?? 'file');
      files.push(new File([blob], name, { type: blob.type || 'application/octet-stream' }));
    } catch {
      // Packaged/dev security policy may block file:// fetch; items path covers most cases.
    }
  }
  return files;
}

function readUriList(dataTransfer: DataTransfer): string[] {
  const raw = [
    safeGetData(dataTransfer, 'text/uri-list'),
    safeGetData(dataTransfer, 'public.file-url'),
  ]
    .filter((value) => value.length > 0)
    .join('\n');
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

function safeGetData(dataTransfer: DataTransfer, type: string): string {
  try {
    return dataTransfer.getData(type) || '';
  } catch {
    return '';
  }
}
