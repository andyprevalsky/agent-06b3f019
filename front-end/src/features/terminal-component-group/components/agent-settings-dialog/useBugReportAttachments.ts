/**
 * Screenshot picker attachments for the Report Bug composer.
 *
 * STATE (per picked image):
 *   [PICKED] -- invalid type / too large --> rejected + toast (never uploaded)
 *   [PICKED] -- valid --> [UPLOADING] (local thumbnail shown at once)
 *   [UPLOADING] -- upload ok --> [READY] (holds the signed URL)
 *   [UPLOADING] -- upload err --> removed + toast
 *   any state -- remove --> dropped (a late upload result is ignored)
 *   any state -- dialog close / agent change (generation bump) --> cleared
 *
 * Uses the same POST /report-bug/screenshots upload as drag/paste. On submit
 * READY attachments are appended to the description as `![name](url)` lines,
 * so the report-bug request contract stays `{ description }`; with no
 * attachments the description is sent unchanged.
 */

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { uploadBugReportScreenshot, useToast } from '../../hooks';
import { markdownAlt } from './useBugReportScreenshots';

/** Mirrors the backend screenshot whitelist and multer limit. */
export const BUG_REPORT_SCREENSHOT_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const MAX_BUG_REPORT_SCREENSHOT_BYTES = 10 * 1024 * 1024;

export interface BugReportAttachment {
  id: number;
  name: string;
  /** Local object URL for the thumbnail (null where the browser lacks one). */
  previewUrl: string | null;
  status: 'uploading' | 'ready';
  /** Signed URL once uploaded. */
  url: string | null;
}

export interface UseBugReportAttachmentsResult {
  attachments: BugReportAttachment[];
  uploadingCount: number;
  addAttachments: (files: File[]) => void;
  removeAttachment: (id: number) => void;
  clearAttachments: () => void;
  /** Description with READY screenshots appended as markdown image lines. */
  withAttachments: (description: string) => string;
}

function rejectionReason(file: File): string | null {
  if (!BUG_REPORT_SCREENSHOT_TYPES.includes(file.type)) {
    return `${file.name} is not a PNG, JPEG, GIF or WebP image`;
  }
  if (file.size > MAX_BUG_REPORT_SCREENSHOT_BYTES) {
    return `${file.name} is larger than ${MAX_BUG_REPORT_SCREENSHOT_BYTES / 1024 / 1024} MB`;
  }
  return null;
}

function createPreview(file: File): string | null {
  return typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : null;
}

function revokePreview(attachment: BugReportAttachment): void {
  if (attachment.previewUrl !== null && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(attachment.previewUrl);
  }
}

export function useBugReportAttachments(
  agentId: string | null,
  generationRef: MutableRefObject<number>,
): UseBugReportAttachmentsResult {
  const { toast } = useToast();
  const [attachments, setAttachments] = useState<BugReportAttachment[]>([]);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const nextId = useRef(0);

  const clearAttachments = useCallback(() => {
    attachmentsRef.current.forEach(revokePreview);
    setAttachments([]);
  }, []);

  useEffect(() => () => attachmentsRef.current.forEach(revokePreview), []);

  const uploadOne = useCallback(
    async (targetAgentId: string, id: number, file: File) => {
      const generation = generationRef.current;
      try {
        const shot = await uploadBugReportScreenshot(targetAgentId, file);
        if (generationRef.current !== generation) return;
        setAttachments((list) =>
          list.map((a) => (a.id === id ? { ...a, status: 'ready', url: shot.url } : a)),
        );
      } catch (error) {
        if (generationRef.current !== generation) return;
        setAttachments((list) => {
          const failed = list.find((a) => a.id === id);
          if (failed) revokePreview(failed);
          return list.filter((a) => a.id !== id);
        });
        toast({
          title: 'Could not attach screenshot',
          description: error instanceof Error ? error.message : 'Failed to upload screenshot',
          variant: 'destructive',
        });
      }
    },
    [generationRef, toast],
  );

  const addAttachments = useCallback(
    (files: File[]) => {
      if (agentId === null) return;
      const accepted: Array<{ file: File; attachment: BugReportAttachment }> = [];
      files.forEach((file) => {
        const reason = rejectionReason(file);
        if (reason !== null) {
          toast({ title: 'Screenshot not attached', description: reason, variant: 'destructive' });
          return;
        }
        nextId.current += 1;
        accepted.push({
          file,
          attachment: {
            id: nextId.current,
            name: markdownAlt(file.name),
            previewUrl: createPreview(file),
            status: 'uploading',
            url: null,
          },
        });
      });
      if (accepted.length === 0) return;
      setAttachments((list) => [...list, ...accepted.map((a) => a.attachment)]);
      accepted.forEach(({ file, attachment }) => void uploadOne(agentId, attachment.id, file));
    },
    [agentId, toast, uploadOne],
  );

  const removeAttachment = useCallback((id: number) => {
    setAttachments((list) => {
      const removed = list.find((a) => a.id === id);
      if (removed) revokePreview(removed);
      return list.filter((a) => a.id !== id);
    });
  }, []);

  const withAttachments = useCallback(
    (description: string) => {
      const lines = attachments
        .filter((a) => a.status === 'ready' && a.url !== null)
        .map((a) => `![${a.name}](${a.url})`);
      return lines.length === 0 ? description : `${description}\n\n${lines.join('\n')}`;
    },
    [attachments],
  );

  return {
    attachments,
    uploadingCount: attachments.filter((a) => a.status === 'uploading').length,
    addAttachments,
    removeAttachment,
    clearAttachments,
    withAttachments,
  };
}
