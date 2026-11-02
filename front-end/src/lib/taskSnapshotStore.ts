/**
 * Task snapshot lifecycle:
 *   subscribed -> pinned (never evicted)
 *   last unsubscribe / publish without subscribers -> recent unused history
 *   history over 128 tasks -> evict oldest unused snapshot
 *
 * Reads are pure and snapshots stay referentially stable for useSyncExternalStore.
 * The separate unused queue keeps eviction O(1), even with many mounted tasks.
 */
const MAX_UNUSED_TASKS = 128;

export function createTaskSnapshotStore<T>(accept: (current: T, next: T) => boolean) {
  const entries = new Map<string, { value: T | null; listeners: Set<() => void> }>();
  const unused = new Set<string>();

  function retainUnused(taskId: string) {
    unused.delete(taskId);
    unused.add(taskId);
    if (unused.size > MAX_UNUSED_TASKS) {
      const oldest = unused.values().next().value;
      if (oldest !== undefined) {
        unused.delete(oldest);
        entries.delete(oldest);
      }
    }
  }

  return {
    get(taskId: string): T | null {
      return entries.get(taskId)?.value ?? null;
    },
    publish(taskId: string, value: T): void {
      let entry = entries.get(taskId);
      if (entry?.value != null && !accept(entry.value, value)) return;
      if (!entry) {
        entry = { value, listeners: new Set() };
        entries.set(taskId, entry);
      } else {
        entry.value = value;
      }
      if (entry.listeners.size === 0) retainUnused(taskId);
      entry.listeners.forEach((listener) => listener());
    },
    subscribe(taskId: string, listener: () => void): () => void {
      let entry = entries.get(taskId);
      if (!entry) {
        entry = { value: null, listeners: new Set() };
        entries.set(taskId, entry);
      }
      unused.delete(taskId);
      entry.listeners.add(listener);
      return () => {
        if (!entry.listeners.delete(listener)) return;
        if (entry.listeners.size !== 0) return;
        if (entry.value === null) entries.delete(taskId);
        else retainUnused(taskId);
      };
    },
    clear(): void {
      unused.clear();
      for (const [taskId, entry] of entries) {
        if (entry.listeners.size === 0) entries.delete(taskId);
        else {
          entry.value = null;
          entry.listeners.forEach((listener) => listener());
        }
      }
    },
  };
}
