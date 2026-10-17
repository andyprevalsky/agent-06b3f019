/** SQL-budget ownership for Hub I/O; cancellation is not remote rollback. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

export const HUB_SQL_TIMEOUT_MS = 5 * 60_000;
type Ownership = {
  deadline: number;
  controller: AbortController;
  pending: Set<Promise<unknown>>;
  versions: Map<string, string | null>;
};
const ownership = new AsyncLocalStorage<Ownership>();

export function assertHubStorageOwnership(): void {
  const scope = ownership.getStore();
  if (!scope) return;
  if (performance.now() >= scope.deadline && !scope.controller.signal.aborted) {
    scope.controller.abort(new Error('Benchmark Hub SQL ownership budget expired'));
  }
  scope.controller.signal.throwIfAborted();
}

/** Start before Prisma invocation, including SQL admission/lock wait in the budget. */
export async function withHubStorageOwnership<T>(operation: () => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const scope: Ownership = {
    deadline: performance.now() + HUB_SQL_TIMEOUT_MS,
    controller,
    pending: new Set(),
    versions: new Map(),
  };
  const timer = setTimeout(() => {
    controller.abort(new Error('Benchmark Hub SQL ownership budget expired'));
  }, HUB_SQL_TIMEOUT_MS);
  try {
    return await ownership.run(scope, async () => {
      assertHubStorageOwnership();
      const result = await operation();
      assertHubStorageOwnership();
      return result;
    });
  } finally {
    // Join local SDK/body work even on SQL rejection. Abort cannot prove R2 noncommit.
    controller.abort(new Error('Benchmark Hub SQL ownership ended'));
    await Promise.allSettled([...scope.pending]);
    clearTimeout(timer);
  }
}

export async function ownedHubStorageRequest<T>(
  operation: (signal?: AbortSignal) => Promise<T>
): Promise<T> {
  assertHubStorageOwnership();
  const scope = ownership.getStore();
  const pending = operation(scope?.controller.signal);
  scope?.pending.add(pending);
  try {
    const result = await pending;
    assertHubStorageOwnership();
    return result;
  } finally {
    scope?.pending.delete(pending);
  }
}

/** Object versions are scoped to one SQL owner, never a process-wide cache. */
export function hubStorageVersions(): Map<string, string | null> | undefined {
  assertHubStorageOwnership();
  return ownership.getStore()?.versions;
}
