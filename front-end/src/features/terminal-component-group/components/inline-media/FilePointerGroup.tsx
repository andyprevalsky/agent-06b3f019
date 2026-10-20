/**
 * FilePointerGroup — a list of output files.
 *
 * STATE MACHINE: Stateless split on the Rose Desktop flag (lib/roseDesktop.ts).
 *   Rose Desktop: media (images/videos) -> one InlineMediaGallery (single or strip)
 *                 other files           -> FilePointerDisplay each (chip or mini-preview)
 *   stock:        every file            -> FilePointerDisplay each (unchanged markup)
 */

import { useRoseDesktop } from '@/hooks/roseDesktopContext';
import type { FilePointer } from '../../hooks';
import { FilePointerDisplay } from '../FilePointerDisplay';
import { InlineMediaGallery } from './InlineMediaGallery';
import { splitInlineMedia } from './inlineMedia.utils';

export function FilePointerGroup({
  files,
  showMiniPreview = false,
}: {
  files: FilePointer[];
  showMiniPreview?: boolean;
}) {
  const roseDesktop = useRoseDesktop();
  const { media, other } = roseDesktop ? splitInlineMedia(files) : { media: [], other: files };
  return (
    <div className="flex w-full flex-col gap-2">
      {media.length > 0 && <InlineMediaGallery files={media} />}
      {other.map((fp, idx) => (
        <FilePointerDisplay key={`${idx}:${fp.id}`} file={fp} showMiniPreview={showMiniPreview} />
      ))}
    </div>
  );
}
