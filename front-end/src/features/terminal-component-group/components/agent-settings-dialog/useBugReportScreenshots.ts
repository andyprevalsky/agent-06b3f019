/**
 * Screenshot drag/paste for the Report Bug description.
 *
 * STATE (per dropped or pasted image):
 *   [DROPPED] -- insert `![Uploading name…]()` at the cursor --> [UPLOADING]
 *   [UPLOADING] -- upload ok --> placeholder becomes `![name](signed-url)`
 *   [UPLOADING] -- upload err --> placeholder removed + toast
 *   any state -- dialog close / agent change (generation bump) --> result ignored
 *
 * The boxes.dev automation accepts only prompt text, so a screenshot reaches
 * the investigating agent as an image link inside the description the admin
 * sees and submits. Submit stays disabled while any upload is pending.
 */

import { useCallback, useRef, useState, type MutableRefObject } from 'react';
import { uploadBugReportScreenshot, useToast } from '../../hooks';

export interface UseBugReportScreenshotsOptions {
  agentId: string | null;
  setDescription: (update: (current: string) => string) => void;
  /** Bumped on dialog close / agent switch; stale uploads must not write back. */
  generationRef: MutableRefObject<number>;
}

export interface UseBugReportScreenshotsResult {
  uploadingCount: number;
  /** Forget pending uploads after the description was reset. */
  resetUploads: () => void;
  /** Returns false when none of the files is an image (let the default action run). */
  attachScreenshots: (files: File[], cursor: number | null) => boolean;
}

export function isScreenshotFile(file: File): boolean {
  return file.type.startsWith('image/');
}

export function markdownAlt(name: string): string {
  return name.replace(/[[\]\n]/g, ' ').trim() || 'screenshot';
}

function insertAt(text: string, cursor: number | null, insertion: string): string {
  const at = cursor === null ? text.length : Math.min(Math.max(cursor, 0), text.length);
  const before = text.slice(0, at);
  const after = text.slice(at);
  const lead = before === '' || before.endsWith('\n') ? '' : '\n';
  const trail = after.startsWith('\n') ? '' : '\n';
  return `${before}${lead}${insertion}${trail}${after}`;
}

export function useBugReportScreenshots({
  agentId,
  setDescription,
  generationRef,
}: UseBugReportScreenshotsOptions): UseBugReportScreenshotsResult {
  const { toast } = useToast();
  const [uploadingCount, setUploadingCount] = useState(0);
  const nextPlaceholderId = useRef(0);

  const uploadOne = useCallback(
    async (targetAgentId: string, file: File, placeholder: string) => {
      const generation = generationRef.current;
      try {
        const shot = await uploadBugReportScreenshot(targetAgentId, file);
        if (generationRef.current !== generation) return;
        setDescription((d) => d.replace(placeholder, `![${markdownAlt(shot.name)}](${shot.url})`));
      } catch (error) {
        if (generationRef.current !== generation) return;
        setDescription((d) => d.replace(`${placeholder}\n`, '').replace(placeholder, ''));
        toast({
          title: 'Could not attach screenshot',
          description: error instanceof Error ? error.message : 'Failed to upload screenshot',
          variant: 'destructive',
        });
      } finally {
        if (generationRef.current === generation) setUploadingCount((n) => Math.max(0, n - 1));
      }
    },
    [generationRef, setDescription, toast],
  );

  const attachScreenshots = useCallback(
    (files: File[], cursor: number | null): boolean => {
      const images = files.filter(isScreenshotFile);
      if (images.length === 0 || agentId === null) return false;
      const placeholders = images.map((file) => {
        nextPlaceholderId.current += 1;
        return `![Uploading ${markdownAlt(file.name)} #${nextPlaceholderId.current}…]()`;
      });
      setDescription((d) => insertAt(d, cursor, placeholders.join('\n')));
      setUploadingCount((n) => n + images.length);
      images.forEach((file, i) => void uploadOne(agentId, file, placeholders[i]));
      return true;
    },
    [agentId, setDescription, uploadOne],
  );

  const resetUploads = useCallback(() => setUploadingCount(0), []);

  return { uploadingCount, resetUploads, attachScreenshots };
}
