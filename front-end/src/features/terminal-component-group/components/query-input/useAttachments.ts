/**
 * Attachment lifecycle hook for QueryInput.
 *
 * Owns the pending-attachments array, paste/drag handlers, and thumbnail-URL
 * cleanup. Uploads go through the domain's `uploadAttachment` (api.ts); this
 * hook never calls `fetch` directly.
 *
 * STATE MACHINE (per attachment):
 *   [pending] -> [uploading] -> [done]
 *                            -> [error]
 *
 * Cleanup contract: `collectDonePointersAndClear()` revokes every blob URL.
 * `remove()` revokes the URL for the removed item.
 */

import { useState, useEffect, useRef, useCallback, useSyncExternalStore } from 'react';
import {
  uploadAttachment,
  MAX_FILE_SIZE,
  MAX_TOTAL_ATTACHMENTS_SIZE,
  useToast,
  type FilePointer,
} from '../../hooks';
import type { PendingAttachment } from './types';

type SetAttachments = React.Dispatch<React.SetStateAction<PendingAttachment[]>>;

interface UseAttachmentsResult {
  attachments: PendingAttachment[];
  hasUploading: boolean;
  hasFailed: boolean;
  processFiles: (files: FileList | File[]) => Promise<void>;
  remove: (id: string) => void;
  collectDonePointersAndClear: () => FilePointer[];
  collectDonePointers: () => FilePointer[];
  isDragOver: boolean;
  dragHandlers: {
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
  };
}

const drafts = new Map<string, PendingAttachment[]>();
const listeners = new Set<() => void>();
const EMPTY_ATTACHMENTS: PendingAttachment[] = [];
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

interface UseAttachmentsOptions {
  draftKey?: string;
  /** Ref to the textarea — paste events only trigger when it has focus. */
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}

export function useAttachments({
  textareaRef,
  draftKey,
}: UseAttachmentsOptions): UseAttachmentsResult {
  const { toast } = useToast();
  const [localAttachments, setLocalAttachments] = useState<PendingAttachment[]>([]);
  const saved = useSyncExternalStore(subscribe, () =>
    draftKey ? (drafts.get(draftKey) ?? EMPTY_ATTACHMENTS) : EMPTY_ATTACHMENTS,
  );
  const attachments = draftKey ? saved : localAttachments;
  const setAttachments: SetAttachments = useCallback(
    (action) => {
      if (!draftKey) {
        setLocalAttachments(action);
        return;
      }
      const previous = drafts.get(draftKey) ?? EMPTY_ATTACHMENTS;
      drafts.set(draftKey, typeof action === 'function' ? action(previous) : action);
      for (const listener of listeners) listener();
    },
    [draftKey],
  );
  const [isDragOver, setIsDragOver] = useState(false);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  const processFiles = useCallback(
    async (files: FileList | File[]) => {
      const currentTotal = attachmentsRef.current.reduce((sum, a) => sum + a.file.size, 0);
      let added = 0;
      for (const file of Array.from(files)) {
        const skip = shouldSkipFile(file, currentTotal + added, toast);
        if (skip === 'skip') continue;
        if (skip === 'stop') break;
        added += file.size;
        await uploadOne(file, setAttachments);
      }
    },
    [toast, setAttachments],
  );

  const remove = useCallback(
    (id: string) => {
      setAttachments((prev) => {
        const toRemove = prev.find((a) => a.id === id);
        if (toRemove?.thumbnailUrl) URL.revokeObjectURL(toRemove.thumbnailUrl);
        return prev.filter((a) => a.id !== id);
      });
    },
    [setAttachments],
  );

  const collectDonePointers = () =>
    attachmentsRef.current
      .filter((a) => a.status === 'done' && a.filePointer)
      .map((a) => a.filePointer as FilePointer);
  const collectDonePointersAndClear = useCallback((): FilePointer[] => {
    const pointers = attachmentsRef.current
      .filter((a) => a.status === 'done' && a.filePointer)
      .map((a) => a.filePointer as FilePointer);
    attachmentsRef.current.forEach((a) => {
      if (a.thumbnailUrl) URL.revokeObjectURL(a.thumbnailUrl);
    });
    setAttachments([]);
    return pointers;
  }, [setAttachments]);

  usePasteFiles(textareaRef, processFiles);
  const dragHandlers = useDragHandlers(setIsDragOver, processFiles);

  return {
    attachments,
    hasUploading: attachments.some((a) => a.status === 'uploading'),
    hasFailed: attachments.some((a) => a.status === 'error'),
    processFiles,
    remove,
    collectDonePointersAndClear,
    collectDonePointers,
    isDragOver,
    dragHandlers,
  };
}

type ToastFn = ReturnType<typeof useToast>['toast'];

function shouldSkipFile(file: File, sizeBefore: number, toast: ToastFn): 'ok' | 'skip' | 'stop' {
  if (file.size > MAX_FILE_SIZE) {
    toast({
      title: 'File too large',
      description: `${file.name} exceeds the 20MB limit`,
      variant: 'destructive',
    });
    return 'skip';
  }
  if (sizeBefore + file.size > MAX_TOTAL_ATTACHMENTS_SIZE) {
    toast({
      title: 'Total size limit exceeded',
      description: 'Total attachments cannot exceed 100MB',
      variant: 'destructive',
    });
    return 'stop';
  }
  return 'ok';
}

function usePasteFiles(
  textareaRef: React.RefObject<HTMLTextAreaElement | null>,
  processFiles: (files: File[]) => Promise<void>,
): void {
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const active = document.activeElement;
      if (active !== textarea && !textarea.contains(active)) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const item of items) {
        if (item.kind !== 'file') continue;
        const file = item.getAsFile();
        if (!file) continue;
        const ext = file.type.split('/')[1] || 'png';
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        files.push(new File([file], `screenshot-${timestamp}.${ext}`, { type: file.type }));
      }
      if (files.length > 0) {
        e.preventDefault();
        void processFiles(files);
      }
    };
    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [processFiles, textareaRef]);
}

function useDragHandlers(
  setIsDragOver: React.Dispatch<React.SetStateAction<boolean>>,
  processFiles: (files: FileList | File[]) => Promise<void>,
) {
  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(true);
    },
    [setIsDragOver],
  );
  const onDragLeave = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
    },
    [setIsDragOver],
  );
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      const files = e.dataTransfer.files;
      if (files && files.length > 0) void processFiles(files);
    },
    [setIsDragOver, processFiles],
  );
  return { onDragOver, onDragLeave, onDrop };
}

async function uploadOne(file: File, setAttachments: SetAttachments): Promise<void> {
  const thumbnailUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
  const pending: PendingAttachment = {
    id: crypto.randomUUID(),
    file,
    status: 'uploading',
    progress: 0,
    thumbnailUrl,
  };
  setAttachments((prev) => [...prev, pending]);
  try {
    const filePointer = await uploadAttachment(file, (progress) => {
      setAttachments((prev) => prev.map((a) => (a.id === pending.id ? { ...a, progress } : a)));
    });
    setAttachments((prev) =>
      prev.map((a) =>
        a.id === pending.id ? { ...a, status: 'done', progress: 100, filePointer } : a,
      ),
    );
  } catch (error) {
    setAttachments((prev) =>
      prev.map((a) =>
        a.id === pending.id
          ? {
              ...a,
              status: 'error',
              error: error instanceof Error ? error.message : 'Upload failed',
            }
          : a,
      ),
    );
  }
}
