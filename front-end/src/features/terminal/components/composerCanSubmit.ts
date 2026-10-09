/** Send vs Stop. A live ACTIVE row with sticky !isChatMode is Stop. */
export function composerCanSubmit(input: {
  selectedAgentId?: string | null;
  pendingGateCount?: number;
  hasActiveAttentionRequest?: boolean;
  status?: string | null;
  isChatMode: boolean;
}): boolean {
  return (
    !input.selectedAgentId ||
    (input.pendingGateCount ?? 0) > 0 ||
    input.hasActiveAttentionRequest === true ||
    input.status === 'PAUSED' ||
    input.status === 'COMPLETED' ||
    input.status === 'FAILED' ||
    input.status === 'COST_LIMIT_REACHED' ||
    input.isChatMode
  );
}
