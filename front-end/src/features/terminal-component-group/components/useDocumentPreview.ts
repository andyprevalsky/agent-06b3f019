/**
 * useDocumentPreview — loads signed URL + parsed preview body for a FilePointer.
 *
 * STATE MACHINE:
 * [idle] --enabled+file--> [loading] --ok--> [ready]
 *                            |--fail--> [error]
 * [any] --disabled|file null|unmount--> [idle] (object URLs revoked; in-flight fetch aborted)
 */

import { useEffect, useRef, useState } from 'react';
import type { FilePointer } from '../hooks';
import {
  DocumentPreviewLoadError,
  loadDocumentPreview,
  type DocumentPreviewPayload,
} from './documentPreview.load';

export type DocumentPreviewLoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; payload: DocumentPreviewPayload }
  | { status: 'error'; message: string; downloadUrl?: string };

export function documentPreviewFileKey(file: FilePointer | null | undefined): string | null {
  if (!file) return null;
  return JSON.stringify([
    file.id,
    file.storage_path,
    file.original_filename,
    file.mime_type,
    file.size_bytes,
    file.created_at,
  ]);
}

export function useDocumentPreview(
  file: FilePointer | null | undefined,
  enabled: boolean,
  options?: { activeSheet?: string; allowInlineScripts?: boolean },
): DocumentPreviewLoadState {
  const [loadState, setLoadState] = useState<DocumentPreviewLoadState>({ status: 'idle' });
  const activeSheet = options?.activeSheet;
  const allowInlineScripts = options?.allowInlineScripts === true;
  const fileRef = useRef(file);
  fileRef.current = file;
  const loadKey = documentPreviewFileKey(file);

  useEffect(() => {
    const fileSnapshot = fileRef.current;
    if (!enabled || !fileSnapshot) {
      setLoadState({ status: 'idle' });
      return;
    }

    const controller = new AbortController();
    const objectUrls: string[] = [];
    setLoadState({ status: 'loading' });

    void (async () => {
      try {
        const result = await loadDocumentPreview(fileSnapshot, {
          activeSheet,
          signal: controller.signal,
          allowInlineScripts,
        });
        if (controller.signal.aborted) {
          result.objectUrls.forEach((url) => URL.revokeObjectURL(url));
          return;
        }
        objectUrls.push(...result.objectUrls);
        setLoadState({ status: 'ready', payload: result.payload });
      } catch (err) {
        if (controller.signal.aborted) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        const downloadUrl = err instanceof DocumentPreviewLoadError ? err.downloadUrl : undefined;
        setLoadState({
          status: 'error',
          message: err instanceof Error ? err.message : 'Failed to load document',
          downloadUrl,
        });
      }
    })();

    return () => {
      controller.abort();
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [enabled, loadKey, activeSheet, allowInlineScripts]);

  return loadState;
}
