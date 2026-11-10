/**
 * useInlineMediaUrls — resolves signed URLs for inline media files.
 *
 * STATE MACHINE (per file id):
 *   [PENDING] --signed--> [READY url]
 *            \--fail----> [FAILED] (rendered as an unavailable placeholder)
 * Re-runs when the file set or agent changes; stale resolutions are dropped.
 *
 * Agent attachments are signed by the backend (agent-scoped endpoint, works
 * for read-only shared views); files without an agent are signed client-side
 * in the user's own storage bucket.
 */

import { useEffect, useRef, useState } from 'react';

import { supabase } from '@/lib/supabase';
import { getAttachmentUrl, type FilePointer } from '../../hooks';
import { SIGNED_URL_TTL_SECONDS } from '../documentPreview.load';

export type InlineMediaUrlState = Record<string, string | null>;

async function signMediaUrl(
  file: FilePointer,
  agentId: string | undefined,
  signal: AbortSignal,
): Promise<string> {
  if (agentId) return getAttachmentUrl(agentId, file.id, file.storage_path, { signal });
  const { data, error } = await supabase.storage
    .from('attachments')
    .createSignedUrl(file.storage_path, SIGNED_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) throw new Error(error?.message || 'Could not sign media URL');
  return data.signedUrl;
}

/** Map of file id -> signed URL (string), failure (null); absent = pending. */
export function useInlineMediaUrls(
  files: FilePointer[],
  agentId: string | undefined,
): InlineMediaUrlState {
  const [urls, setUrls] = useState<InlineMediaUrlState>({});
  // `key` captures file identities; the `files` array identity churns per
  // render, so the effect reads the latest list through a ref.
  const filesRef = useRef(files);
  filesRef.current = files;
  const key = files.map((f) => `${f.id}:${f.storage_path}`).join('|');

  useEffect(() => {
    const controller = new AbortController();
    setUrls({});
    for (const file of filesRef.current) {
      if (!file.storage_path) {
        setUrls((prev) => ({ ...prev, [file.id]: null }));
        continue;
      }
      signMediaUrl(file, agentId, controller.signal).then(
        (url) => {
          if (!controller.signal.aborted) setUrls((prev) => ({ ...prev, [file.id]: url }));
        },
        () => {
          if (!controller.signal.aborted) setUrls((prev) => ({ ...prev, [file.id]: null }));
        },
      );
    }
    return () => {
      controller.abort();
    };
  }, [key, agentId]);

  return urls;
}
