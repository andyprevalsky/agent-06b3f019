/**
 * Preview reads for the open app / an on-screen preview card.
 *
 * useCodePreviewStatus (open app only; one GET per open or reload, no polling):
 *   [LOADING] --GET /claude-code-session/:taskId/preview--> [READY(view)]
 *   [LOADING] --403 ROSE_DEV_ONLY--> [HIDDEN] (render nothing)
 *   [LOADING] --other failure--> [ERROR]
 *
 * usePreviewFrameSrc (each frame load gets a fresh single-use sign-in code):
 *   disabled / no URL → null
 *   [HANDOFF] --POST …/preview/handoff ok--> preview_url#rose_preview_handoff=<code>
 *   [HANDOFF] --fails (e.g. 404 before L-APPS2 ships)--> preview_url (no fragment)
 *   reloadKey / URL / task change → a new handoff
 *
 * useOnScreen: one IntersectionObserver per card; the card's frame only lives
 * while it is on screen.
 */
import { useEffect, useState, type RefObject } from 'react';

import {
  createPreviewHandoff,
  fetchCodePreview,
  ROSE_DEV_ONLY,
  UserAppsApiError,
  type CodePreviewView,
} from '@/lib/api/userApps';

import { withPreviewHandoff } from './appFrame';

export type CodePreviewState =
  | { kind: 'loading' }
  | { kind: 'ready'; view: CodePreviewView }
  | { kind: 'hidden' }
  | { kind: 'error' };

function isDevOnly(error: unknown): boolean {
  return error instanceof UserAppsApiError && error.code === ROSE_DEV_ONLY;
}

export function useCodePreviewStatus(taskId: string | null, reloadKey: number): CodePreviewState {
  const [state, setState] = useState<CodePreviewState>({ kind: 'loading' });
  useEffect(() => {
    if (taskId === null) return;
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
  }, [taskId, reloadKey]);
  return state;
}

export function usePreviewFrameSrc({
  taskId,
  previewUrl,
  enabled,
  reloadKey,
}: {
  taskId: string | null;
  previewUrl: string | null;
  enabled: boolean;
  reloadKey: number;
}): string | null {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    setSrc(null);
    if (!enabled || previewUrl === null) return;
    if (taskId === null) {
      setSrc(previewUrl);
      return;
    }
    let cancelled = false;
    createPreviewHandoff(taskId).then(
      ({ code }) => {
        if (!cancelled) setSrc(withPreviewHandoff(previewUrl, code));
      },
      () => {
        if (!cancelled) setSrc(previewUrl);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [taskId, previewUrl, enabled, reloadKey]);
  return src;
}

export function useOnScreen(ref: RefObject<Element>): boolean {
  const [onScreen, setOnScreen] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (element === null || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setOnScreen(entry.isIntersecting);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return onScreen;
}
