/**
 * Release Tilion sessions that THIS database owns and no longer holds.
 *
 * Tilion has no session tags and one account is shared by prod, dev and
 * benchmarks, so an account listing never implies ownership. A session is
 * released only when it is both still live remotely AND recorded in our
 * BrowserSession table as provider=tilion in a terminal status:
 *
 *   listLiveTilionSessionIds()  (account-wide, ≤ concurrency cap)
 *     ├─ no BrowserSession row here           → leave alone (another environment)
 *     ├─ row provider ≠ tilion                → leave alone
 *     ├─ row ACTIVE or PAUSED                 → leave alone (a task owns it)
 *     └─ row CLOSED or ERROR                  → release (idempotent; 404/410 = released)
 *
 * Runs inside the per-minute terminal-browser-release lease (agentCleanup.ts).
 * 10k agents: one list call bounded by the account's live-session cap and one
 * unique-index lookup over those ids; no per-agent work.
 */
import { prisma } from '../database';
import { createLogger } from '../logger';
import { listLiveTilionSessionIds, releaseTilionRemoteSession } from './tilion';

const log = createLogger('TilionSessionReaper');

/** Terminal statuses whose remote session must no longer be live. */
export const TILION_REAPABLE_STATUSES = ['CLOSED', 'ERROR'] as const;

export interface TilionReaperDependencies {
  apiKeyConfigured: () => boolean;
  listLiveSessionIds: () => Promise<string[]>;
  /** Of `candidates`, the ids our DB records as provider=tilion in a reapable status. */
  ownedTerminalSessionIds: (candidates: string[]) => Promise<Set<string>>;
  release: (sessionId: string) => Promise<void>;
}

export interface TilionReaperSummary {
  live: number;
  owned: number;
  released: number;
  failed: number;
  releasedIds: string[];
}

async function ownedTerminalTilionSessionIds(candidates: string[]): Promise<Set<string>> {
  if (candidates.length === 0) return new Set();
  const rows = await prisma.browserSession.findMany({
    where: {
      sessionId: { in: candidates },
      provider: 'tilion',
      status: { in: [...TILION_REAPABLE_STATUSES] },
    },
    select: { sessionId: true },
  });
  return new Set(rows.map((row) => row.sessionId));
}

function defaultDependencies(): TilionReaperDependencies {
  return {
    apiKeyConfigured: () => (process.env.TILION_API_KEY ?? '').trim() !== '',
    listLiveSessionIds: listLiveTilionSessionIds,
    ownedTerminalSessionIds: ownedTerminalTilionSessionIds,
    release: releaseTilionRemoteSession,
  };
}

export async function reconcileOrphanedTilionSessions(
  overrides: Partial<TilionReaperDependencies> = {}
): Promise<TilionReaperSummary> {
  const deps = { ...defaultDependencies(), ...overrides };
  const summary: TilionReaperSummary = {
    live: 0,
    owned: 0,
    released: 0,
    failed: 0,
    releasedIds: [],
  };
  if (!deps.apiKeyConfigured()) return summary;
  const live = [...new Set(await deps.listLiveSessionIds())];
  summary.live = live.length;
  const owned = await deps.ownedTerminalSessionIds(live);
  // Intersect again so a dependency can never widen the set beyond live ∩ owned.
  const targets = live.filter((sessionId) => owned.has(sessionId));
  summary.owned = targets.length;
  for (const sessionId of targets) {
    try {
      await deps.release(sessionId);
      summary.released += 1;
      summary.releasedIds.push(sessionId);
      log.warn('Released an orphaned Tilion session', { session_id: sessionId });
    } catch (error) {
      summary.failed += 1;
      log.error('Failed to release an orphaned Tilion session', {
        session_id: sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return summary;
}
