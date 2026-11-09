/** Pending capture is owned by its agent; terminal archive publication joins it. */
const pending = new Map<string, Set<Promise<void>>>();
const failures = new Map<string, unknown>();

export function ownLlmCapture(agentId: string, task: Promise<void>): void {
  let tasks = pending.get(agentId);
  if (!tasks) {
    tasks = new Set();
    pending.set(agentId, tasks);
  }
  const owned = task
    .catch((error: unknown) => {
      if (!failures.has(agentId)) failures.set(agentId, error);
    })
    .finally(() => {
      tasks.delete(owned);
      if (tasks.size === 0) pending.delete(agentId);
    });
  tasks.add(owned);
}

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
