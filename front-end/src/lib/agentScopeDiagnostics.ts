/** Identity-only diagnostics for cross-agent UI isolation. Never include message content. */
export function recordAgentSelection(
  previousAgentId: string | null | undefined,
  nextAgentId: string | null | undefined,
): void {
  if (previousAgentId === nextAgentId) return;
  console.info('Agent scope: selection changed', { previousAgentId, nextAgentId });
}

export function recordAgentScopeDiscard(
  surface: string,
  ownerAgentId: string | null | undefined,
  activeAgentId: string | null | undefined,
): void {
  console.warn('Agent scope: discarded stale work', { surface, ownerAgentId, activeAgentId });
}
