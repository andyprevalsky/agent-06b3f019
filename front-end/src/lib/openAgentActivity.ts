/**
 * In-tab signal: the open agent view saw realtime activity.
 *
 * WRITERS (existing channels only — this module opens none)
 *   agent:<openAgentId> INSERT (new message) ----+
 *   agent:<openAgentId> UPDATE (status change) --+--> listeners (in-tab Set)
 *   bus:<rootId> AGENT_STATE_CHANGED -------------+     e.g. user-ui live refresh
 *     (sub-agent tree the open view already holds)
 *
 * Each realtime event costs one call over the (normally 0–1) listeners; the
 * listener is responsible for coalescing/debouncing any follow-up work.
 */

export type OpenAgentActivityKind = 'message' | 'status' | 'sub-agent';

export interface OpenAgentActivity {
  agentId: string;
  kind: OpenAgentActivityKind;
}

type Listener = (activity: OpenAgentActivity) => void;

const listeners = new Set<Listener>();

export function notifyOpenAgentActivity(activity: OpenAgentActivity): void {
  listeners.forEach((listener) => listener(activity));
}

export function onOpenAgentActivity(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
