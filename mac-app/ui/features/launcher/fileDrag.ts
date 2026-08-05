/**
 * File-drag detection helpers for the quick launcher.
 *
 * On macOS, Finder / screenshot-thumbnail drags often omit the literal
 * `Files` type during `dragover`/`dragenter` and only populate `files` on
 * `drop`. Gate acceptance on a broader type set so we still call
 * `preventDefault()` and claim the drop (otherwise Electron lets the drop
 * fall through the transparent always-on-top window onto apps behind).
 */

const FILE_DRAG_TYPES = new Set([
  'Files',
  'files',
  'text/uri-list',
  'public.file-url',
  'application/x-moz-file',
]);

export function looksLikeFileDrag(dataTransfer: DataTransfer | null | undefined): boolean {
  if (dataTransfer == null) return false;

  const types = Array.from(dataTransfer.types ?? []);
  if (types.some((type) => FILE_DRAG_TYPES.has(type))) return true;
  if (types.some((type) => type.toLowerCase().includes('file'))) return true;

  const items = dataTransfer.items;
  if (items != null) {
    for (let i = 0; i < items.length; i += 1) {
      if (items[i]?.kind === 'file') return true;
    }
  }

  return (dataTransfer.files?.length ?? 0) > 0;
}
