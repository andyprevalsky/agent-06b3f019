/**
 * Pure helpers for inline media (images + videos rendered in the trajectory
 * by default instead of a click-to-reveal chip). No React.
 * Inline media is Rose Desktop only (lib/roseDesktop.ts); callers check the flag.
 */

import type { FilePointer } from '@/lib/api/types';
import { documentPreviewKind } from '../documentPreview.utils';

export type InlineMediaKind = 'image' | 'video';

export function inlineMediaKind(file: FilePointer): InlineMediaKind | null {
  const kind = documentPreviewKind(file, { video: true });
  return kind === 'image' || kind === 'video' ? kind : null;
}

export function isInlineMedia(file: FilePointer): boolean {
  return inlineMediaKind(file) !== null;
}

/** Splits files into inline media (gallery) and everything else (chips/tiles). */
export function splitInlineMedia(files: FilePointer[]): {
  media: FilePointer[];
  other: FilePointer[];
} {
  const media: FilePointer[] = [];
  const other: FilePointer[] = [];
  for (const file of files) (isInlineMedia(file) ? media : other).push(file);
  return { media, other };
}

/** Default reserved aspect ratio until intrinsic size is known. */
export const DEFAULT_MEDIA_ASPECT = 16 / 9;

/** Aspect ratio from file metadata (width/height) when present and sane. */
export function metadataAspectRatio(file: FilePointer): number | null {
  const { width, height } = file;
  if (typeof width !== 'number' || typeof height !== 'number') return null;
  if (!(width > 0) || !(height > 0)) return null;
  return width / height;
}
