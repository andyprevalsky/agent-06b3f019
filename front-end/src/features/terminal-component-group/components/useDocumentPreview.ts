/**
 * useDocumentPreview — loads signed URL + parsed preview body for a FilePointer.
 *
 * STATE MACHINE:
 * [idle] --enabled+file--> [loading] --ok--> [ready]
 *                            |--fail--> [error]
 * [any] --disabled|file null|unmount--> [idle] (object URLs revoked)
 */

import { useEffect, useState } from 'react';
import type { FilePointer } from '../hooks';
import {
  loadDocumentPreview,
  type DocumentPreviewPayload,
} from './documentPreview.load';

export type DocumentPreviewLoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; payload: DocumentPreviewPayload }
  | { status: 'error'; message: string };

export function useDocumentPreview(
  file: FilePointer | null | undefined,
  enabled: boolean,
  options?: { activeSheet?: string },
): DocumentPreviewLoadState {
  const [loadState, setLoadState] = useState<DocumentPreviewLoadState>({ status: 'idle' });
  const activeSheet = options?.activeSheet;

  useEffect(() => {
    if (!enabled || !file) {
      setLoadState({ status: 'idle' });
      return;
    }

    let cancelled = false;
    const objectUrls: string[] = [];
    setLoadState({ status: 'loading' });

    void (async () => {
      try {
        const result = await loadDocumentPreview(file, { activeSheet });
        objectUrls.push(...result.objectUrls);
        if (!cancelled) {
          setLoadState({ status: 'ready', payload: result.payload });
        } else {
          result.objectUrls.forEach((url) => URL.revokeObjectURL(url));
        }
      } catch (err) {
        if (cancelled) return;
        setLoadState({
          status: 'error',
          message: err instanceof Error ? err.message : 'Failed to load document',
        });
      }
    })();

    return () => {
      cancelled = true;
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [enabled, file, activeSheet]);

  return loadState;
}
