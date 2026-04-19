/**
 * Resolves a list of `/test-assets/*` paths into `File` objects suitable for
 * the QueryInput attachment pipeline. Delegates the HTTP fetch and HTML/404
 * handling to `fetchPublicAsset` in the domain api layer.
 *
 * Missing assets are silently skipped; the caller receives only the files
 * that resolved successfully.
 */

import { fetchPublicAsset } from '../../hooks';

const MIME_BY_EXT: Record<string, string> = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  csv: 'text/csv',
  txt: 'text/plain',
};

function resolveMimeType(filename: string, blobType: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (ext && MIME_BY_EXT[ext]) return MIME_BY_EXT[ext];
  return blobType;
}

export async function fetchTestPromptFiles(attachmentUrls: string[]): Promise<File[]> {
  const assets = await Promise.all(attachmentUrls.map((path) => fetchPublicAsset(path)));
  return assets
    .filter((asset): asset is { blob: Blob; filename: string } => asset !== null)
    .map(({ blob, filename }) => {
      const mimeType = resolveMimeType(filename, blob.type);
      return new File([blob], filename, { type: mimeType });
    });
}
