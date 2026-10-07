export const TERMINAL_STATUSES = new Set([
  'COMPLETED',
  'FAILED',
  'OUT_OF_CREDITS',
  'COST_LIMIT_REACHED',
]);

/** Finished runs have no live workflow. Always publish that so the composer can restore chat. */
export function workflowIdForStatusBroadcast(
  status: string,
  temporalWorkflowId: string | null
): string | null {
  return TERMINAL_STATUSES.has(status) ? null : temporalWorkflowId;
}
