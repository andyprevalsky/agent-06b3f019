/**
 * Download handler for non-media message attachments. Extracted from
 * AttachmentDisplay so the component stays under the strict
 * max-lines-per-function cap. (Images/videos render inline via
 * InlineMediaGallery and open in DocumentPreviewDrawer instead.)
 */
import { useCallback } from 'react';
import type { FilePointer } from '../../hooks';
import { downloadAttachmentAsBlob, getAttachmentUrl, useToast } from '../../hooks';

interface UseAttachmentActionsArgs {
  agentId: string | undefined;
}

export function useAttachmentActions({ agentId }: UseAttachmentActionsArgs) {
  const { toast } = useToast();

  const handleDownload = useCallback(
    async (fp: FilePointer) => {
      try {
        if (!fp.storage_path || !agentId) throw new Error('Cannot download file');
        const url = await getAttachmentUrl(agentId, fp.id, fp.storage_path);
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
    [agentId, toast],
  );

  return { handleDownload };
}
