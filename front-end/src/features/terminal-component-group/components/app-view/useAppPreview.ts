/**
 * Preview reads for the open app view.
 *
 * useCodePreviewStatus (open view only; one GET per open, no polling):
 *   [LOADING] --GET /claude-code-session/:taskId/preview--> [READY(view)]
 *   [LOADING] --403 ROSE_DEV_ONLY--> [HIDDEN] (render nothing)
 *   [LOADING] --other failure--> [ERROR]
 *
 * usePreviewFrameSrc (each frame load gets a fresh single-use sign-in code):
 *   disabled → [IDLE]
 *   [MINTING] --POST …/preview/handoff 201 {code, preview_url}-->
 *       [READY] <mint preview_url>#rose_preview_handoff=<code> (never the app origin)
 *   [MINTING] --409 PREVIEW_UNAVAILABLE / no usable preview_url--> [STARTING]
 *   [MINTING] --403 USER_SESSION_REQUIRED | ROSE_DEV_ONLY--> [HIDDEN] (nothing)
 *   [MINTING] --404 / other failure--> [ERROR]
 *   task / enabled change → a new code (codes are single-use, 60 s)
 */
import { useEffect, useState } from 'react';

import {
  CodePreviewApiError,
  createPreviewHandoff,
  fetchCodePreview,
  PREVIEW_UNAVAILABLE,
  ROSE_DEV_ONLY,
  type CodePreviewView,
} from '@/lib/api/codePreview';

import { isCrossOriginHttpUrl, withPreviewHandoff } from './appFrame';

export type CodePreviewState =
  | { kind: 'loading' }
  | { kind: 'ready'; view: CodePreviewView }
  | { kind: 'hidden' }
  | { kind: 'error' };

function isDevOnly(error: unknown): boolean {
  return error instanceof CodePreviewApiError && error.code === ROSE_DEV_ONLY;
}

export function useCodePreviewStatus(taskId: string): CodePreviewState {
  const [state, setState] = useState<CodePreviewState>({ kind: 'loading' });
  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    fetchCodePreview(taskId).then(
      (view) => {
        if (!cancelled) setState({ kind: 'ready', view });
      },
      (error: unknown) => {
        if (!cancelled) setState(isDevOnly(error) ? { kind: 'hidden' } : { kind: 'error' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [taskId]);
  return state;
}

export type PreviewFrameState =
  | { kind: 'idle' }
  | { kind: 'ready'; src: string }
  | { kind: 'starting' }
  | { kind: 'hidden' }
  | { kind: 'error' };

function handoffFailure(error: unknown): PreviewFrameState {
  if (error instanceof CodePreviewApiError) {
    if (error.code === PREVIEW_UNAVAILABLE) return { kind: 'starting' };
    if (error.status === 403) return { kind: 'hidden' };
  }
  return { kind: 'error' };
}

export function usePreviewFrameSrc(taskId: string, enabled: boolean): PreviewFrameState {
  const [state, setState] = useState<PreviewFrameState>({ kind: 'idle' });
  useEffect(() => {
    setState({ kind: 'idle' });
    if (!enabled) return;
    let cancelled = false;
    createPreviewHandoff(taskId).then(
      ({ code, preview_url: previewUrl }) => {
        if (cancelled) return;
        setState(
          isCrossOriginHttpUrl(previewUrl)
            ? { kind: 'ready', src: withPreviewHandoff(previewUrl, code) }
            : { kind: 'starting' },
        );
      },
      (error: unknown) => {
        if (!cancelled) setState(handoffFailure(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [taskId, enabled]);
  return state;
}
