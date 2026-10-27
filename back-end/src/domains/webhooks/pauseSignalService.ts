/**
 * Pause-signal compatibility across Temporal worker generations.
 *
 *   subscription lapse ──▶ parent_state_query probe ──▶ reports user_pause_active?
 *                                                        ├─ yes ─▶ signal('pause', 'subscription')
 *                                                        └─ no / probe failed ─▶ signal('pause')
 */

import { createLogger } from '../../providers/logger';
import type { getTemporalClient } from '../../providers/temporal';

type TemporalClient = Awaited<ReturnType<typeof getTemporalClient>>;
type TemporalWorkflowHandle = ReturnType<TemporalClient['workflow']['getHandle']>;

const log = createLogger('Webhooks');

/** Bound for the cause-capability probe; a slow or absent worker gets the legacy pause. */
const PAUSE_CAUSE_PROBE_TIMEOUT_MS = 5_000;

/**
 * Pause-signal arguments the workflow's own code accepts. An older generation
 * still draining on its queue defines `pause(self)`; Temporal calls it with every
 * signal argument, so a cause would fail that workflow task on every retry. Only
 * the cause-aware generation reports `user_pause_active` from parent_state_query.
 */
export async function subscriptionPauseArgs(
  client: TemporalClient,
  handle: TemporalWorkflowHandle,
  agentId: string
): Promise<['subscription'] | []> {
  try {
    const state: unknown = await client.withDeadline(
      Date.now() + PAUSE_CAUSE_PROBE_TIMEOUT_MS,
      () => handle.query('parent_state_query')
    );
    if (typeof state === 'object' && state !== null && 'user_pause_active' in state) {
      return ['subscription'];
    }
  } catch (error) {
    log.warn('Pause cause probe failed; sending legacy pause', {
      workflow_id: handle.workflowId,
      agent_id: agentId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return [];
}
