/**
 * Fetches signed URLs for image attachments in parallel and exposes them as a
 * map keyed by file_pointer id.
 *
 * STATE MACHINE:
 *   [PENDING]     - mount / attachments changed, signed URLs not yet resolved
 *     |  (Promise.all resolves)
 *     v
 *   [RESOLVED]    - imageUrls populated for any storage-backed image attachments
 *     |  (caller calls setImageUrlFor on cache miss)
 *     v
 *   [CACHED-EXTRA] - URLs backfilled on lightbox open for lazy thumbnails
 */
import { useEffect, useState, useCallback } from 'react';
import type { FilePointer } from '../../hooks';
import { getAttachmentUrl } from '../../hooks';

interface UseAttachmentImagesReturn {
  imageUrls: Record<string, string>;
  setImageUrlFor: (id: string, url: string) => void;
}

export function useAttachmentImages(
  attachments: FilePointer[],
  agentId: string | undefined,
): UseAttachmentImagesReturn {
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!agentId) return;

    const imageAttachments = attachments.filter(
      (fp) => fp.mime_type.startsWith('image/') && fp.storage_path,
    );
    if (imageAttachments.length === 0) return;

    let cancelled = false;
    const fetchAll = async () => {
      const results = await Promise.all(
        imageAttachments.map(async (fp) => {
          try {
            const url = await getAttachmentUrl(agentId, fp.id, fp.storage_path);
            return { id: fp.id, url };
          } catch {
            return { id: fp.id, url: '' };
          }
        }),
      );
      if (cancelled) return;
      const urlMap: Record<string, string> = {};
      results.forEach(({ id, url }) => {
        if (url) urlMap[id] = url;
      });
      setImageUrls(urlMap);
    };

    void fetchAll();
    return () => {
      cancelled = true;
    };
  }, [attachments, agentId]);

  const setImageUrlFor = useCallback((id: string, url: string) => {
    setImageUrls((prev) => ({ ...prev, [id]: url }));
  }, []);

  return { imageUrls, setImageUrlFor };
}
