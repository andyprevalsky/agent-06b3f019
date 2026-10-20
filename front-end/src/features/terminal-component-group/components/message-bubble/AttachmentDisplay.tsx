/**
 * Renders a list of FilePointer attachments on a message.
 *
 * STATE MACHINE (stateless split):
 *   images/videos -> InlineMediaGallery (inline by default, full width;
 *                    2+ form a gallery strip; tap/click -> DocumentPreviewDrawer)
 *   markdown      -> MarkdownAttachmentCard (auto-fetched, inline)
 *   other         -> download tile
 *
 * Download flow: handled by useAttachmentActions (blob fetch + <a download>).
 */
import { memo } from 'react';
import type { FilePointer } from '../../hooks';
import { InlineMediaGallery } from '../inline-media/InlineMediaGallery';
import { splitInlineMedia } from '../inline-media/inlineMedia.utils';
import { AttachmentItem } from './AttachmentItem';
import { useAttachmentActions } from './useAttachmentActions';
import { useMarkdownAttachments } from './useMarkdownAttachments';

interface AttachmentDisplayProps {
  attachments: FilePointer[];
  agentId?: string;
}

export const AttachmentDisplay = memo(function AttachmentDisplay({
  attachments,
  agentId,
}: AttachmentDisplayProps) {
  const markdownPreviews = useMarkdownAttachments(attachments, agentId);
  const { handleDownload } = useAttachmentActions({ agentId });

  if (!attachments || attachments.length === 0) return null;
  const { media, other } = splitInlineMedia(attachments);

  return (
    <div className="mt-2 flex w-full flex-col gap-2">
      {media.length > 0 && <InlineMediaGallery files={media} agentId={agentId} />}
      {other.length > 0 && (
        <div className="flex w-full flex-wrap gap-2">
          {other.map((fp) => (
            <AttachmentItem
              key={fp.id}
              fp={fp}
              markdownPreview={markdownPreviews[fp.id]}
              onDownload={(target) => void handleDownload(target)}
            />
          ))}
        </div>
      )}
    </div>
  );
});
