import { MAX_RECONNECT_DELAY_MS } from '../config';
import { isAgentScopeActive, isAgentScopeCurrent, type AgentScope } from './agentScope';
import type { RealtimeSubscriptionDeps } from './useRealtimeSubscription';

export function createReconnectScheduler(deps: RealtimeSubscriptionDeps, scope: AgentScope) {
  const active = () => isAgentScopeActive(deps.selectedAgentIdRef, scope, 'realtime-subscription');
  return () => {
    if (!active() || !deps.canSubscribe) return;
    if (deps.reconnectTimeoutRef.current) clearTimeout(deps.reconnectTimeoutRef.current);
    const attempt = deps.reconnectAttemptRef.current;
    deps.reconnectAttemptRef.current += 1;
    const backoff = attempt === 0 ? 0 : Math.min(1000 * 2 ** (attempt - 1), MAX_RECONNECT_DELAY_MS);
    const delay = backoff === 0 ? 0 : backoff + Math.floor(Math.random() * 250);
    const timeoutId = globalThis.setTimeout(() => {
      if (deps.reconnectTimeoutRef.current !== timeoutId) return;
      deps.reconnectTimeoutRef.current = null;
      if (!active() || typeof globalThis.window === 'undefined') return;
      deps.setForceResubscribeCounter((previous) =>
        isAgentScopeCurrent(deps.selectedAgentIdRef, scope) ? previous + 1 : previous,
      );
    }, delay) as unknown as number;
    deps.reconnectTimeoutRef.current = timeoutId;
  };
}
