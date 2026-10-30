import {
  applyFastModeInheritance,
  applySpeedInheritance,
  applyMemoryInheritance,
  applyWorldModelModeInheritance,
  disableFastModeForWorldModel,
} from './agentExecutionMode';
import type { CreateAgentBody } from './types';
import * as repo from './repo';

export type BatchParentExecutionFlags = Awaited<
  ReturnType<typeof repo.findExecutionModeFlagsByIds>
>[number];

export async function loadBatchParentExecutionFlags(
  bodies: CreateAgentBody[],
  userId: string
): Promise<Map<string, BatchParentExecutionFlags>> {
  const parentIds = Array.from(
    new Set(
      bodies
        .map((body) => body.parent_agent_id)
        .filter((parentId): parentId is string => parentId !== undefined)
    )
  );
  if (parentIds.length === 0) return new Map();
  // Scope to the caller so foreign parent UUIDs cannot escalate benchmark mocks.
  const parents = await repo.findExecutionModeFlagsByIds(parentIds, userId);
  return new Map(parents.map((parent) => [parent.id, parent]));
}

export function applyExecutionModeInheritanceForBatch(
  bodies: CreateAgentBody[],
  parentById: Map<string, BatchParentExecutionFlags>
): void {
  for (const body of bodies) {
    if (body.parent_agent_id === undefined) continue;
    const parent = parentById.get(body.parent_agent_id);
    applyFastModeInheritance(body, parent?.fastModeCacheEnabled);
    applySpeedInheritance(body, parent);
    applyWorldModelModeInheritance(body, parent?.worldModelMode);
    applyMemoryInheritance(body, parent?.memoryEnabled);
    disableFastModeForWorldModel(body);
  }
}

export function inheritsBenchmarkFromBatchParent(
  body: CreateAgentBody,
  parentById: Map<string, BatchParentExecutionFlags>
): boolean {
  if (body.parent_agent_id === undefined) return false;
  return parentById.get(body.parent_agent_id)?.isBenchmark === true;
}
