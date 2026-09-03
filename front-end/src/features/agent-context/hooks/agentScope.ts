import type React from 'react';
import { recordAgentScopeDiscard } from '@/lib/agentScopeDiagnostics';

export interface AgentScope {
  agentId: string;
  cancelled: boolean;
  discardReported: boolean;
}

export function isAgentScopeActive(
  selectedAgentIdRef: React.MutableRefObject<string | null>,
  scope: AgentScope,
  surface: string,
): boolean {
  const active = !scope.cancelled && selectedAgentIdRef.current === scope.agentId;
  if (!active && !scope.discardReported) {
    scope.discardReported = true;
    recordAgentScopeDiscard(surface, scope.agentId, selectedAgentIdRef.current);
  }
  return active;
}

export function scopedSetter<T>(
  setter: React.Dispatch<React.SetStateAction<T>>,
  isActive: () => boolean,
): React.Dispatch<React.SetStateAction<T>> {
  return (action) => {
    setter((previous) => {
      if (!isActive()) return previous;
      return typeof action === 'function' ? (action as (current: T) => T)(previous) : action;
    });
  };
}
