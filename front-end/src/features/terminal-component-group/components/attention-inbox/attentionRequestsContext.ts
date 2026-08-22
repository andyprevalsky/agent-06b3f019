/**
 * Context object + readers for the app-wide attention-request subscription.
 *
 * Split from AttentionRequestsProvider.tsx so that file exports only a
 * component — a module that mixes components with plain functions breaks React
 * Fast Refresh for every consumer of the file.
 *
 * See AttentionRequestsProvider for why the subscription is shared at all.
 */

import { createContext, useContext } from 'react';

import type { UseAttentionRequestsResult } from './useAttentionRequests';
import type { AttentionRequest } from './types';

export const AttentionRequestsContext = createContext<UseAttentionRequestsResult | null>(null);

/** Agent ids with at least one unanswered request — the sidebar's needs-help input. */
export function unansweredAgentIds(requests: AttentionRequest[]): Set<string> {
  return new Set(requests.filter((r) => !r.answered).map((r) => r.agent_id));
}

/**
 * Read the shared attention state.
 *
 * Throws when no provider is mounted rather than degrading to an empty list: a
 * silently-empty inbox looks identical to "you have no notifications", which is
 * exactly the kind of wiring bug that survives to production.
 */
export function useAttentionRequestsContext(): UseAttentionRequestsResult {
  const ctx = useContext(AttentionRequestsContext);
  if (ctx === null) {
    throw new Error('useAttentionRequestsContext must be used within an AttentionRequestsProvider');
  }
  return ctx;
}
