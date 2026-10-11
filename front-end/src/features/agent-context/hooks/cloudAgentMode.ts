/**
 * Chat <-> cloud-agent mode transitions announced by realtime INSERTs:
 * a cloud_agent IN_PROGRESS plan/execute start enters agent mode, and the
 * root's final completion_summary returns to chat mode.
 */

import type { InsertMessagePayload } from '@/lib/realtime';

export function startsCloudAgentMode(data: InsertMessagePayload, agentId: string): boolean {
  const metadata = data.metadata;
  return (
    data.agentId === agentId &&
    metadata?.toolName === 'cloud_agent' &&
    metadata.toolStatus === 'IN_PROGRESS' &&
    (metadata.startPhase === 'plan' || metadata.startPhase === 'execute')
  );
}

export function endsCloudAgentMode(data: InsertMessagePayload, agentId: string): boolean {
  const metadata = data.metadata;
  return (
    data.agentId === agentId &&
    metadata?.toolName === 'completion_summary' &&
    metadata.toolStatus === 'FINISHED' &&
    metadata.isFinalSummary === true &&
    (metadata.subAgentId === undefined || metadata.subAgentId === null)
  );
}
