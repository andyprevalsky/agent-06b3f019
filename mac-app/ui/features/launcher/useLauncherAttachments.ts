/**
 * Local file holding + drag/drop for the quick launcher.
 *
 * The launcher has no HTTP boundary (fetch invariant). Files stay as local
 * `File` objects here and are serialized into the submit IPC payload; the
 * main window uploads them before createAgent.
 *
 * STATE MACHINE:
 *   [idle] --dragover(files)--> [drag_over] --dragleave--> [idle]
 *   [drag_over] --drop--> [has_files]
 *   [has_files] --remove--> [has_files|idle]
 *   [has_files|idle] --toggle open--> [idle] (cleared)
 *     --screenshot captured--> [has_files] (caller's screen held like a drop)
 */

import { useCallback, useRef, useState, type DragEvent as ReactDragEvent } from 'react';
import type { QuickQueryAttachment } from '../../../shared/types/ipc';
import { setQuickQueryFileDrag } from './api';
import { LAUNCHER_MAX_FILE_SIZE, LAUNCHER_MAX_TOTAL_ATTACHMENTS_SIZE } from './config';
import { extractDroppedFilesAsync, looksLikeFileDrag } from './fileDrag';
import type { LauncherLocalAttachment } from './types';

export interface LauncherAttachmentsHandle {
  attachments: LauncherLocalAttachment[];
  isDragOver: boolean;
  attachError: string | null;
  dragHandlers: {
    onDragOver: (e: ReactDragEvent) => void;
    onDragLeave: (e: ReactDragEvent) => void;
    onDrop: (e: ReactDragEvent) => void;
  };
  addFiles: (files: FileList | File[]) => void;
  remove: (id: string) => void;
  /** Drop every held file; on open, then hold the screenshot main captured. */
  reset: (screenshot?: QuickQueryAttachment) => void;
  serializeForSubmit: () => Promise<QuickQueryAttachment[]>;
}

export function useLauncherAttachments(): LauncherAttachmentsHandle {
  const [attachments, setAttachments] = useState<LauncherLocalAttachment[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  const addFiles = useCallback((files: FileList | File[]) => {
    const { accepted, error } = acceptIncomingFiles(Array.from(files), attachmentsRef.current);
    setAttachError(error);
    if (accepted.length > 0) {
      setAttachments((prev) => [...prev, ...accepted]);
    }
  }, []);

  const remove = useCallback((id: string) => {
    setAttachError(null);
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const reset = useCallback(
    (screenshot?: QuickQueryAttachment) => {
      // addFiles size-checks against the ref, which must not count the files
      // being dropped here.
      attachmentsRef.current = [];
      setAttachError(null);
      setIsDragOver(false);
      setAttachments([]);
      if (screenshot !== undefined) addFiles([attachmentToFile(screenshot)]);
    },
    [addFiles]
  );

  const serializeForSubmit = useCallback(async (): Promise<QuickQueryAttachment[]> => {
    return Promise.all(
      attachmentsRef.current.map(async (a) => ({
        name: a.file.name,
        mimeType: a.file.type || 'application/octet-stream',
        size: a.file.size,
        data: await readFileBytes(a.file),
      }))
    );
  }, []);

  const dragHandlers = useFileDragHandlers(setIsDragOver, addFiles);

  return {
    attachments,
    isDragOver,
    attachError,
    dragHandlers,
    addFiles,
    remove,
    reset,
    serializeForSubmit,
  };
}

function acceptIncomingFiles(
  incoming: File[],
  current: LauncherLocalAttachment[]
): { accepted: LauncherLocalAttachment[]; error: string | null } {
  let total = current.reduce((sum, a) => sum + a.file.size, 0);
  const accepted: LauncherLocalAttachment[] = [];
  let error: string | null = null;
  for (const file of incoming) {
    if (file.size > LAUNCHER_MAX_FILE_SIZE) {
      error = `${file.name} exceeds the 20MB limit`;
      continue;
    }
    if (total + file.size > LAUNCHER_MAX_TOTAL_ATTACHMENTS_SIZE) {
      error = 'Total attachments cannot exceed 100MB';
      break;
    }
    total += file.size;
    accepted.push({ id: crypto.randomUUID(), file });
  }
  return { accepted, error };
}

function useFileDragHandlers(
  setIsDragOver: (value: boolean) => void,
  addFiles: (files: FileList | File[]) => void
): LauncherAttachmentsHandle['dragHandlers'] {
  const onDragOver = useCallback(
    (e: ReactDragEvent) => {
      // Always claim the drag on the launcher surface. Gating preventDefault
      // on type==='Files' lets macOS screenshot/Finder drags fall through the
      // transparent always-on-top window onto apps behind.
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer !== null && e.dataTransfer !== undefined) {
        e.dataTransfer.dropEffect = 'copy';
      }
      // Tell main to cancel blur-hide on ANY claimed dragover. Screenshot
      // pasteboard types are often empty/unknown until drop; gating this on
      // looksLikeFileDrag left fileDragActive=false and the pill still hid.
      void setQuickQueryFileDrag(true);
      if (!looksLikeFileDrag(e.dataTransfer)) return;
      setIsDragOver(true);
    },
    [setIsDragOver]
  );

  const onDragLeave = useCallback(
    (e: ReactDragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const next = e.relatedTarget as Node | null;
      if (next !== null && next !== undefined && e.currentTarget.contains(next)) return;
      setIsDragOver(false);
      void setQuickQueryFileDrag(false);
    },
    [setIsDragOver]
  );

  const onDrop = useCallback(
    (e: ReactDragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      void setQuickQueryFileDrag(false);
      // Screenshot thumbnails often leave files[] empty and only fill items /
      // uri-list — extractDroppedFilesAsync covers all three surfaces.
      const dataTransfer = e.dataTransfer;
      void extractDroppedFilesAsync(dataTransfer).then((files) => {
        if (files.length > 0) addFiles(files);
      });
    },
    [addFiles, setIsDragOver]
  );

  return { onDragOver, onDragLeave, onDrop };
}

/** Rebuild a main-process attachment (the open-time screenshot) as a held File. */
function attachmentToFile(attachment: QuickQueryAttachment): File {
  return new File([attachment.data], attachment.name, { type: attachment.mimeType });
}

/** jsdom's File lacks `arrayBuffer()`; FileReader covers that path in tests + older engines. */
function readFileBytes(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') {
    return file.arrayBuffer();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
        return;
      }
      reject(new Error('Failed to read file bytes'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.readAsArrayBuffer(file);
  });
}
