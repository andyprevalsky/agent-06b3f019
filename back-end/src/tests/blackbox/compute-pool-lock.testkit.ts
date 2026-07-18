/**
 * Cross-process mutex for blackbox tests that mutate the SHARED compute-token
 * pool (Integration rows with name claude_code/gpt_code, poolingEnabled=true).
 *
 * Forced-pool credential fetches select by LRU across EVERY eligible pool row
 * in the database, so tests that seed pool fixtures and assert exact token
 * identity are only sound while no other writer seeds/flips pool rows
 * mid-test. Running such cases sequentially within one suite process is NOT
 * enough: a second test-suite process sharing the same Postgres (overlapping
 * full-suite runs, coverage runs, standalone domain reruns) can seed its own
 * pool rows a few ms after this suite snapshots the pre-existing ids, and
 * those foreign rows win the LRU selection. Observed 2026-07-18: two
 * integrations rotation tests failed when foreign pool rows
 * (c19244b9…/ce70849c…) seeded by a concurrent suite instance were returned
 * instead of the tests' own fixtures.
 *
 * Every test block that seeds pool-eligible rows or asserts pool-selection
 * order must run inside withComputePoolLock. Current holders:
 *   - integrations.blackbox.ts  → the rotation/lineage/affinity sequential block
 *   - claude-code.blackbox.ts   → testBoundary_createCallsE2bApi (pooled seed)
 */
import { prisma } from '../../providers/database';

const COMPUTE_POOL_LOCK_KEY = 'blackbox:compute-token-pool';

// Generous budget: the lock waits for a peer process's whole rotation block,
// which can stretch under full-suite load. Suite-level timeouts fire long
// before this cap in healthy runs.
const COMPUTE_POOL_LOCK_BUDGET_MS = 15 * 60 * 1000;

export async function withComputePoolLock<T>(fn: () => Promise<T>): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      // pg_advisory_xact_lock blocks until the peer's transaction commits and
      // auto-releases on commit/rollback — no unlock bookkeeping, crash-safe.
      // Same pattern as the backend's compute-token lineage lease acquisition
      // (src/providers/computeCredentials.ts).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${COMPUTE_POOL_LOCK_KEY}))`;
      return fn();
    },
    { maxWait: COMPUTE_POOL_LOCK_BUDGET_MS, timeout: COMPUTE_POOL_LOCK_BUDGET_MS }
  );
}
