import type { CodeAgentListItem } from '@/lib/api/tree';

/** A leased or paused container alone does not mean this task is working. */
export function isCodeAgentRunning(code: CodeAgentListItem): boolean {
  return (
    code.status === 'ACTIVE' &&
    !code.awaiting_parent &&
    code.container_state !== 'stopped' &&
    code.container_state !== 'destroyed'
  );
}
