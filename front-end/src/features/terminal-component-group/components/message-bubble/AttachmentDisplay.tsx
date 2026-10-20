/**
 * Renders a list of FilePointer attachments on a message.
 *
 * STATE MACHINE (split on the Rose Desktop flag, lib/roseDesktop.ts):
 *
 *   ROSE DESKTOP (stateless split):
 *     images/videos -> InlineMediaGallery (inline by default, full width;
 *                      2+ form a gallery strip; tap/click -> DocumentPreviewDrawer)
 *     markdown      -> MarkdownAttachmentCard (auto-fetched, inline)
 *     other         -> download tile
 *
 *   STOCK (unchanged):
 *   [IDLE]                      <-- imageUrls hydrated via useAttachmentImages
 *      |
 *      v (user clicks an image)
 *   [LIGHTBOX OPEN]              <-- lightboxImage !== null
 *      |                              onClose
 *      +-------------------------> [IDLE]
 *
 * Download flow: handled by useAttachmentActions (blob fetch + <a download>).
 * Markdown previews fill the available message pane width; stock image
 * thumbnails and generic download tiles keep their intrinsic sizes.
 */
import { memo, useState } from 'react';
import { useRoseDesktop } from '@/hooks/roseDesktopContext';
import type { FilePointer } from '../../hooks';
import { InlineMediaGallery } from '../inline-media/InlineMediaGallery';
import { splitInlineMedia } from '../inline-media/inlineMedia.utils';
import { ImageLightbox } from './ImageLightbox';
import { AttachmentItem } from './AttachmentItem';
import { useAttachmentImages } from './useAttachmentImages';
import { useAttachmentActions } from './useAttachmentActions';
import { useMarkdownAttachments } from './useMarkdownAttachments';

interface AttachmentDisplayProps {
  attachments: FilePointer[];
  agentId?: string;
}

export const AttachmentDisplay = memo(function AttachmentDisplay(props: AttachmentDisplayProps) {
  if (!props.attachments || props.attachments.length === 0) return null;
  return <AttachmentDisplayBody {...props} />;
});

function AttachmentDisplayBody(props: AttachmentDisplayProps) {
  return useRoseDesktop() ? (
    <InlineAttachmentDisplay {...props} />
  ) : (
    <StockAttachmentDisplay {...props} />
  );
}

const NO_IMAGE_URLS: Record<string, string> = {};
const ignore = () => undefined;

/** Rose Desktop: media inline by default; non-media keeps the stock tiles. */
function InlineAttachmentDisplay({ attachments, agentId }: AttachmentDisplayProps) {
  const markdownPreviews = useMarkdownAttachments(attachments, agentId);
  const { handleDownload } = useAttachmentActions({
    agentId,
    imageUrls: NO_IMAGE_URLS,
    setImageUrlFor: ignore,
    setLightboxImage: ignore,
  });
  const { media, other } = splitInlineMedia(attachments);

  return (
    <div data-testid="message-attachments" className="mt-2 flex w-full flex-col gap-2">
      {media.length > 0 && <InlineMediaGallery files={media} agentId={agentId} />}
      {other.length > 0 && (
        <div className="flex w-full flex-wrap gap-2">
          {other.map((fp) => (
            <AttachmentItem
              key={fp.id}
              fp={fp}
              imageSrc=""
              markdownPreview={markdownPreviews[fp.id]}
              onOpenLightbox={ignore}
              onDownload={(target) => void handleDownload(target)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function StockAttachmentDisplay({ attachments, agentId }: AttachmentDisplayProps) {
  const [lightboxImage, setLightboxImage] = useState<{ src: string; alt: string } | null>(null);
  const { imageUrls, setImageUrlFor } = useAttachmentImages(attachments, agentId);
  const markdownPreviews = useMarkdownAttachments(attachments, agentId);
  const { handleDownload, openLightbox } = useAttachmentActions({
    agentId,
    imageUrls,
    setImageUrlFor,
    setLightboxImage,
  });

  return (
    <>
      <div className="flex w-full flex-wrap gap-2 mt-2">
        {attachments.map((fp) => (
          <AttachmentItem
            key={fp.id}
            fp={fp}
            imageSrc={imageUrls[fp.id] || ''}
            markdownPreview={markdownPreviews[fp.id]}
            onOpenLightbox={(target) => void openLightbox(target)}
            onDownload={(target) => void handleDownload(target)}
          />
        ))}
      </div>

      {lightboxImage && (
        <ImageLightbox
          src={lightboxImage.src}
          alt={lightboxImage.alt}
          onClose={() => setLightboxImage(null)}
          onDownload={() => {
            const fp = attachments.find((a) => a.original_filename === lightboxImage.alt);
            if (fp) void handleDownload(fp);
          }}
        />
      )}
    </>
  );
}
