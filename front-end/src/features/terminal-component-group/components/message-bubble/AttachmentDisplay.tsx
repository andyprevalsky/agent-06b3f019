/**
 * Renders a list of FilePointer attachments (images & non-images).
 *
 * STATE MACHINE:
 *   [IDLE]                      <-- imageUrls hydrated via useAttachmentImages
 *      |
 *      v (user clicks an image)
 *   [LIGHTBOX OPEN]              <-- lightboxImage !== null
 *      |                              onClose
 *      +-------------------------> [IDLE]
 *
 * Download flow: handled by useAttachmentActions (blob fetch + <a download>).
 */
import { memo, useState } from 'react';
import type { FilePointer } from '../../hooks';
import { ImageLightbox } from './ImageLightbox';
import { AttachmentItem } from './AttachmentItem';
import { useAttachmentImages } from './useAttachmentImages';
import { useAttachmentActions } from './useAttachmentActions';

interface AttachmentDisplayProps {
  attachments: FilePointer[];
  agentId?: string;
}

export const AttachmentDisplay = memo(function AttachmentDisplay({
  attachments,
  agentId,
}: AttachmentDisplayProps) {
  const [lightboxImage, setLightboxImage] = useState<{ src: string; alt: string } | null>(null);
  const { imageUrls, setImageUrlFor } = useAttachmentImages(attachments, agentId);
  const { handleDownload, openLightbox } = useAttachmentActions({
    agentId,
    imageUrls,
    setImageUrlFor,
    setLightboxImage,
  });

  if (!attachments || attachments.length === 0) return null;

  return (
    <>
      <div className="flex flex-wrap gap-2 mt-2">
        {attachments.map((fp) => (
          <AttachmentItem
            key={fp.id}
            fp={fp}
            imageSrc={imageUrls[fp.id] || ''}
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
});
