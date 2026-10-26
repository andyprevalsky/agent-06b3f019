import type React from 'react';

import {
  AttentionRequestsProvider,
  useAttentionRequests,
} from '@/features/terminal-component-group';

/**
 * Mirrors the real TerminalLayout wiring: one attention subscription held above
 * the tree, fanned out via context. Runs the actual hook (MSW serves the
 * endpoint) rather than a stub, so components under test exercise the same path
 * they do in the app.
 */
export function AttentionScope({ children }: { children: React.ReactNode }) {
  const attention = useAttentionRequests(false);
  return <AttentionRequestsProvider value={attention}>{children}</AttentionRequestsProvider>;
}
