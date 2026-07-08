/**
 * Auto-downloads Markdown attachment bodies so AttachmentDisplay can render
 * them inline while retaining the normal explicit file download action.
 *
 * STATE MACHINE:
 *   [IDLE]      - no Markdown attachments or no agentId
 *      |
 *      v
 *   [LOADING]   - signed URL resolved and blob download in flight per file
 *      |
 *      +--> [READY] - blob text decoded and cached by file_pointer id
 *      |
 *      +--> [ERROR] - URL/blob fetch failed for that file
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FilePointer } from '../../hooks';
import { downloadAttachmentAsText, getAttachmentUrl } from '../../hooks';
import { isMarkdownFile } from './attachmentUtils';

export type MarkdownAttachmentPreview =
  { status: 'loading' } | { status: 'ready'; text: string } | { status: 'error'; message: string };

export function useMarkdownAttachments(
  attachments: FilePointer[],
  agentId: string | undefined,
): Record<string, MarkdownAttachmentPreview> {
  const [previews, setPreviews] = useState<Record<string, MarkdownAttachmentPreview>>({});
  const requestedKeysRef = useRef<Map<string, string>>(new Map());
  const markdownAttachments = useMemo(
    () => attachments.filter((fp) => isMarkdownFile(fp) && fp.storage_path),
    [attachments],
  );

  useEffect(() => {
    if (!agentId) {
      requestedKeysRef.current.clear();
      setPreviews({});
      return;
    }

    if (markdownAttachments.length === 0) {
      requestedKeysRef.current.clear();
      setPreviews({});
      return;
    }

    let cancelled = false;
    const currentIds = new Set(markdownAttachments.map((fp) => fp.id));
    for (const requestedId of requestedKeysRef.current.keys()) {
      if (!currentIds.has(requestedId)) requestedKeysRef.current.delete(requestedId);
    }

    setPreviews((prev) => {
      const next: Record<string, MarkdownAttachmentPreview> = {};
      let changed = Object.keys(prev).length !== markdownAttachments.length;
      markdownAttachments.forEach((fp) => {
        next[fp.id] = prev[fp.id] ?? { status: 'loading' };
        changed ||= next[fp.id] !== prev[fp.id];
      });
      return changed ? next : prev;
    });

    const fetchOne = async (fp: FilePointer) => {
      try {
        const url = await getAttachmentUrl(agentId, fp.id, fp.storage_path);
        const text = await downloadAttachmentAsText(url);
        if (cancelled) return;
        setPreviews((prev) => ({ ...prev, [fp.id]: { status: 'ready', text } }));
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : 'Failed to load preview';
        setPreviews((prev) => ({ ...prev, [fp.id]: { status: 'error', message } }));
      }
    };

    markdownAttachments.forEach((fp) => {
      const requestKey = `${fp.storage_path}\u001f${fp.original_filename}`;
      if (requestedKeysRef.current.get(fp.id) === requestKey) return;
      requestedKeysRef.current.set(fp.id, requestKey);
      void fetchOne(fp);
    });

    return () => {
      cancelled = true;
    };
  }, [agentId, markdownAttachments]);

  return previews;
}
