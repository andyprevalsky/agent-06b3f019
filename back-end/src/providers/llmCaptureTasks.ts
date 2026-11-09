/** Pending capture is owned by its agent and archive root; publication joins it. */
const pending = new Map<string, Set<Promise<void>>>();
const failures = new Map<string, unknown>();

/** Register both identities synchronously, before the stream finalizer returns. */
export function ownLlmCapture(agentId: string, task: Promise<void>, rootAgentId = agentId): void {
  const owners = [...new Set([agentId, rootAgentId])].map((id) => {
    let tasks = pending.get(id);
    if (!tasks) {
      tasks = new Set();
      pending.set(id, tasks);
    }
    return { id, tasks };
  });
  const owned = task
    .catch((error: unknown) => {
      for (const { id } of owners) if (!failures.has(id)) failures.set(id, error);
    })
    .finally(() => {
      for (const { id, tasks } of owners) {
        tasks.delete(owned);
        if (tasks.size === 0) pending.delete(id);
      }
    });
  for (const { tasks } of owners) tasks.add(owned);
}

/** Join writers, retaining lost-call failures so a later retry cannot certify completeness. */
export async function drainLlmCaptures(agentIds: readonly string[]): Promise<void> {
  for (;;) {
    const tasks = agentIds.flatMap((id) => [...(pending.get(id) ?? [])]);
    if (tasks.length === 0) break;
    await Promise.all(tasks);
  }
  for (const id of agentIds) {
    if (failures.has(id))
      throw new Error(`LLM archive capture failed for ${id}`, { cause: failures.get(id) });
  }
}
