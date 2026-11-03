import type React from 'react';
import { recordAgentScopeDiscard } from '@/lib/agentScopeDiagnostics';

export interface AgentScope {
  agentId: string;
  cancelled: boolean;
  discardReported: boolean;
  signal?: AbortSignal;
}

/** Pure ownership predicate suitable for React state updater functions. */
export function isAgentScopeCurrent(
  selectedAgentIdRef: React.MutableRefObject<string | null>,
  scope: AgentScope,
): boolean {
  return !scope.cancelled && selectedAgentIdRef.current === scope.agentId;
}

export function isAgentScopeActive(
  selectedAgentIdRef: React.MutableRefObject<string | null>,
  scope: AgentScope,
  surface: string,
): boolean {
  const active = isAgentScopeCurrent(selectedAgentIdRef, scope);
  if (!active && !scope.discardReported) {
    scope.discardReported = true;
    recordAgentScopeDiscard(surface, scope.agentId, selectedAgentIdRef.current);
  }
  return active;
}

export function scopedSetter<T>(
  setter: React.Dispatch<React.SetStateAction<T>>,
  isActive: () => boolean,
  isCurrent: () => boolean,
): React.Dispatch<React.SetStateAction<T>> {
  return (action) => {
    if (!isActive()) return;
    setter((previous) => {
      if (!isCurrent()) return previous;
      return typeof action === 'function' ? (action as (current: T) => T)(previous) : action;
    });
  };
}
