/**
 * The app's single TanStack QueryClient, scoped to the signed-in user.
 *
 * Every cached query (folders, projects, connected repos, ...) belongs to one
 * account. When the signed-in user id changes, the whole cache is dropped before
 * the new identity is applied, so no component renders the previous account's
 * data. That covers sign-out (to the anonymous session) and another account
 * signing in on the same device.
 *
 * STATE MACHINE
 *
 *   [UNSCOPED] --first identity seen--> [SCOPED(id)]            (cache kept)
 *   [SCOPED(a)] --same id (token refresh)--> [SCOPED(a)]         (cache kept)
 *   [SCOPED(a)] --different id or null--> clear(), generation+1 --> [SCOPED(b)]
 *
 * Clearing cannot stop a request already in flight. A mutation that writes the
 * cache on completion captures the generation when it starts (onMutate:
 * captureQueryScope) and writes only while inQueryScope(context) still holds, so
 * account A's late response never lands in account B's cache.
 */
import { QueryClient } from '@tanstack/react-query';

export const appQueryClient = new QueryClient();

let scopedUserId: string | null | undefined;
let generation = 0;

/** Drop every cached query when the signed-in user changes; the first identity seen keeps the cache. */
export function scopeQueryCacheToUser(
  userId: string | null,
  client: QueryClient = appQueryClient,
): void {
  if (scopedUserId !== undefined && scopedUserId !== userId) {
    client.clear();
    generation += 1;
  }
  scopedUserId = userId;
}

/** Mutation context (onMutate): the cache scope the mutation started in. */
export function captureQueryScope(): { queryScope: number } {
  return { queryScope: generation };
}

/** True while the signed-in user is the one the mutation started under. */
export function inQueryScope(context: { queryScope: number } | undefined): boolean {
  return context?.queryScope === generation;
}

/** Forget the scoped identity, so each test starts as a fresh page load. */
export function resetQueryCacheScope(): void {
  scopedUserId = undefined;
}
