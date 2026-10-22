export function makeChipMessage(overrides: Record<string, unknown> = {}) {
  return {
    message_id: overrides.message_id || Math.random().toString(36).slice(2),
    timestamp: new Date().toISOString(),
    text: overrides.text ?? '',
    role: overrides.role ?? 'TOOL',
    metadata: overrides.metadata ?? {},
  };
}

export function makeAgentTreeNode(overrides: Record<string, unknown> = {}) {
  return {
    agentId: overrides.agentId,
    parentAgentId: overrides.parentAgentId ?? null,
    goal: overrides.goal ?? 'Some goal',
    status: overrides.status ?? 'ACTIVE',
    progress: overrides.progress ?? 0,
    toolsInUse: overrides.toolsInUse ?? [],
    messageCount: overrides.messageCount ?? 0,
    costCents: overrides.costCents ?? 12,
    outputSchema: overrides.outputSchema,
    structuredOutput: overrides.structuredOutput,
    failureContext: overrides.failureContext,
    createdAt: overrides.createdAt,
    updatedAt: overrides.updatedAt,
    taskPath: overrides.taskPath,
    backgroundTasks: overrides.backgroundTasks,
  };
}

/**
 * Counts reads of `parentAgentId` on the given tree nodes. Every tree scan
 * visits a node by reading its parent, so `reads` measures total scan work.
 */
export function countParentReads(nodes: Iterable<object>): { reads: number } {
  const counter = { reads: 0 };
  for (const node of nodes) {
    const parent = (node as { parentAgentId?: unknown }).parentAgentId;
    Object.defineProperty(node, 'parentAgentId', {
      configurable: true,
      enumerable: true,
      get: () => {
        counter.reads += 1;
        return parent;
      },
    });
  }
  return counter;
}
