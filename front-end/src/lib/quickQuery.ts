export const QUICK_QUERY_EVENT = 'rose:quick-query';

export interface QuickLauncherPayload {
  query: string;
  submittedAt: number;
}

export function dispatchQuickQueryEvent(payload: QuickLauncherPayload) {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<QuickLauncherPayload>(QUICK_QUERY_EVENT, { detail: payload }),
  );
}
