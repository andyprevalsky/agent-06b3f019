/**
 * FilePointerGroup — a list of output files: media inline, the rest as chips.
 *
 * STATE MACHINE: Stateless split.
 *   media (images/videos) -> one InlineMediaGallery (single or strip)
 *   other files           -> FilePointerDisplay each (chip or mini-preview)
 */

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
  const { media, other } = splitInlineMedia(files);
  return (
    <div className="flex w-full flex-col gap-2">
      {media.length > 0 && <InlineMediaGallery files={media} />}
      {other.map((fp) => (
        <FilePointerDisplay key={fp.id} file={fp} showMiniPreview={showMiniPreview} />
      ))}
    </div>
  );
}
