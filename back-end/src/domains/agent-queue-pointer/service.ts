import { getCurrentAgentQueue, readAgentQueuePointer } from './repo';
import type { AgentQueuePointerPayload } from './types';

export async function getAgentQueuePointerPayload(): Promise<AgentQueuePointerPayload> {
  const row = await readAgentQueuePointer();
  return {
    taskQueue: row?.taskQueue ?? (await getCurrentAgentQueue()),
    surfaceHash: row?.surfaceHash ?? null,
    updatedBy: row?.updatedBy ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}
