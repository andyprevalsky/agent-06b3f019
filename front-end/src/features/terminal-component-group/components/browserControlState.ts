/**
 * Canonical browser-control state shared by every browser surface.
 *
 * Session loss wins over a stale/pending assistance request so labels,
 * animations, overlays, and callbacks cannot disagree when both source flags
 * are briefly true during realtime reconciliation.
 */
export type BrowserControlState = 'active' | 'waiting' | 'disconnected';

export function resolveBrowserControlState({
  isDisconnected,
  isWaitingForAuthAssistance,
}: {
  isDisconnected: boolean;
  isWaitingForAuthAssistance: boolean;
}): BrowserControlState {
  if (isDisconnected) return 'disconnected';
  if (isWaitingForAuthAssistance) return 'waiting';
  return 'active';
}
