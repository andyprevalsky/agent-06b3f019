/**
 * In-tab signal: the open agent view saw realtime activity.
 *
 * WRITERS (existing channels only — this module opens none)
 *   agent:<openAgentId> INSERT (new message) ----+
 *   agent:<openAgentId> UPDATE (status change) --+--> listeners (in-tab Set)
 *   bus:<rootId> AGENT_STATE_CHANGED -------------+     e.g. user-ui live refresh
 *     (sub-agent tree the open view already holds)
 *   agent:<openAgentId> USER_UI_ACTIVE_CHANGED ---+  (kind 'user-ui-active-changed',
 *                                                     carries the new versionId)
 *
 * Each realtime event costs one call over the (normally 0–1) listeners; the
 * listener is responsible for coalescing/debouncing any follow-up work.
 */

export type OpenAgentActivityKind = 'message' | 'status' | 'sub-agent' | 'user-ui-active-changed';

export interface OpenAgentActivity {
  agentId: string;
  kind: OpenAgentActivityKind;
  /** The newly active Rose UI version (kind 'user-ui-active-changed' only). */
  versionId?: string;
}

type Listener = (activity: OpenAgentActivity) => void;

const listeners = new Set<Listener>();

export function notifyOpenAgentActivity(activity: OpenAgentActivity): void {
  listeners.forEach((listener) => listener(activity));
}

/**
 * USER_UI_ACTIVE_CHANGED on the open agent's channel: a code agent in its tree
 * activated `versionId`; the user-ui live refresh skips it when already applied.
 */
export function notifyUserUiActiveChanged(agentId: string, versionId: string): void {
  notifyOpenAgentActivity({ agentId, kind: 'user-ui-active-changed', versionId });
}

/** Channel handler for that event, gated on the subscription still being current. */
export function userUiActiveChangedHandler(isActive: () => boolean, agentId: string) {
  return (data: { versionId: string }) => {
    if (isActive()) notifyUserUiActiveChanged(agentId, data.versionId);
  };
}

export function onOpenAgentActivity(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
