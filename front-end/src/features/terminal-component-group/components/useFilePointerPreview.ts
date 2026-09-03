/**
 * Resolves a signed download URL and, for markdown FilePointers, the preview body.
 *
 * STATE MACHINE:
 * [NO URL] --> downloadUrl: null
 *     |
 *     v (createAttachmentSignedUrl resolves)
 * [READY CHIP] --> non-markdown: signed URL only
 * [MD LOADING] --> markdown: signed URL ready, body in flight
 *     |
 *     +--> [MD READY] --> decoded markdown text
 *     +--> [MD ERROR] --> preview message; signed URL still usable for download
 */
import { useEffect, useState } from 'react';
import { createAttachmentSignedUrl, downloadAttachmentAsText, type FilePointer } from '../hooks';
import { isMarkdownFile } from './message-bubble/attachmentUtils';
import type { MarkdownAttachmentPreview } from './message-bubble/useMarkdownAttachments';

export function useFilePointerPreview(file: FilePointer) {
  const markdown = isMarkdownFile(file);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [markdownPreview, setMarkdownPreview] = useState<MarkdownAttachmentPreview | undefined>(
    markdown ? { status: 'loading' } : undefined,
  );

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const signedUrl = await createAttachmentSignedUrl(file.storage_path);
        if (cancelled) return;
        if (!signedUrl) {
          if (markdown) {
            setMarkdownPreview({ status: 'error', message: 'Failed to load preview' });
          }
          return;
        }
        setDownloadUrl(signedUrl);
        if (!markdown) return;
        const text = await downloadAttachmentAsText(signedUrl);
        if (!cancelled) setMarkdownPreview({ status: 'ready', text });
      } catch (error) {
        if (cancelled || !markdown) return;
        const message = error instanceof Error ? error.message : 'Failed to load preview';
        setMarkdownPreview({ status: 'error', message });
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [file.storage_path, markdown]);

  return { downloadUrl, markdown, markdownPreview };
}
