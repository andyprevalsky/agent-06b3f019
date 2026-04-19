/**
 * Handlers for downloading attachments and opening them in the lightbox.
 * Extracted from AttachmentDisplay so the component stays under the strict
 * max-lines-per-function cap.
 */
import { useCallback } from 'react';
import type { FilePointer } from '../../hooks';
import { downloadAttachmentAsBlob, getAttachmentUrl, useToast } from '../../hooks';

interface UseAttachmentActionsArgs {
  agentId: string | undefined;
  imageUrls: Record<string, string>;
  setImageUrlFor: (id: string, url: string) => void;
  setLightboxImage: (img: { src: string; alt: string } | null) => void;
}

export function useAttachmentActions({
  agentId,
  imageUrls,
  setImageUrlFor,
  setLightboxImage,
}: UseAttachmentActionsArgs) {
  const { toast } = useToast();

  const resolveDownloadUrl = useCallback(
    async (fp: FilePointer): Promise<string> => {
      if (imageUrls[fp.id]) return imageUrls[fp.id];
      if (fp.storage_path && agentId) {
        return getAttachmentUrl(agentId, fp.id, fp.storage_path);
      }
      throw new Error('Cannot download file');
    },
    [agentId, imageUrls],
  );

  const handleDownload = useCallback(
    async (fp: FilePointer) => {
      try {
        const url = await resolveDownloadUrl(fp);
        const blob = await downloadAttachmentAsBlob(url);
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = fp.original_filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);
      } catch (error) {
        toast({
          title: 'Download failed',
          description: error instanceof Error ? error.message : 'Failed to download file',
          variant: 'destructive',
        });
      }
    },
    [resolveDownloadUrl, toast],
  );

  const openLightbox = useCallback(
    async (fp: FilePointer) => {
      let src = imageUrls[fp.id] || '';
      if (!src && fp.storage_path && agentId) {
        try {
          src = await getAttachmentUrl(agentId, fp.id, fp.storage_path);
          setImageUrlFor(fp.id, src);
        } catch {
          toast({ title: 'Failed to load image', variant: 'destructive' });
          return;
        }
      }
      setLightboxImage({ src, alt: fp.original_filename });
    },
    [agentId, imageUrls, setImageUrlFor, setLightboxImage, toast],
  );

  return { handleDownload, openLightbox };
}
