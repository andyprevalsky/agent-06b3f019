/**
 * Attribution-gated cleanup of E2B code sandboxes.
 *
 *   create (e2bSandboxCreate) ──tags──► { roseOrigin, roseStack, codeSessionId, ... }
 *
 *   killStackSandboxes   ── stack teardown (run.sh dropping its own database,
 *                           blackbox runner exit): kill every sandbox tagged with
 *                           THIS stack; their rows are about to disappear.
 *   reapOrphanedCodeSandboxes ── production cron (leased, one replica): kill a
 *                           sandbox only when it carries THIS stack's tag AND a
 *                           codeSessionId whose row is gone, RETIRED, or points at
 *                           another sandbox (paused and older than SUPERSEDED_GRACE_MS).
 *
 * Untagged sandboxes (created before tagging, or by another deployment or
 * database) are never touched: ownership cannot be proven.
 *
 * 10k agents: the provider filters the listing by the stack tag; one tick
 * reads at most `maxSandboxes` (default 200, 100 per page), does one indexed
 * `id IN (...)` read per page and kills at most that many sandboxes. A backlog
 * drains over successive ticks; no work grows with the number of live sessions.
 */
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { Sandbox } from 'e2b';
import cron from 'node-cron';
import { prisma } from '../database';
import { roseSandboxIdentity } from '../e2bSandboxCreate';
import { createLogger } from '../logger';

const log = createLogger('CodeSandboxReaper');

/** A newer sandbox may be mid-restore before its row names it; only old, paused ones are superseded. */
const SUPERSEDED_GRACE_MS = 60 * 60 * 1000;
const PAGE_SIZE = 100;

export interface ListedSandbox {
  sandboxId: string;
  state: string;
  metadata: Record<string, string>;
  startedAt: Date;
}

export interface SandboxReaperDeps {
  /** Running and paused sandboxes whose metadata matches every given tag (at most `limit`). */
  list: (metadata: Record<string, string>, limit: number) => Promise<ListedSandbox[]>;
  kill: (sandboxId: string) => Promise<void>;
}

export const defaultSandboxReaperDeps: SandboxReaperDeps = {
  list: async (metadata, limit) => {
    const paginator = Sandbox.list({
      apiKey: process.env.E2B_API_KEY,
      query: { metadata, state: ['running', 'paused'] },
      limit: PAGE_SIZE,
    });
    const out: ListedSandbox[] = [];
    while (paginator.hasNext && out.length < limit) {
      for (const item of await paginator.nextItems()) {
        out.push({
          sandboxId: item.sandboxId,
          state: item.state,
          metadata: item.metadata ?? {},
          startedAt: item.startedAt,
        });
      }
    }
    return out.slice(0, limit);
  },
  kill: async (sandboxId) => {
    await Sandbox.kill(sandboxId, { apiKey: process.env.E2B_API_KEY });
  },
};

/** Kill every sandbox tagged with this stack (its teardown). Returns how many were killed. */
export async function killStackSandboxes(
  deps: SandboxReaperDeps = defaultSandboxReaperDeps,
  limit = 1000
): Promise<number> {
  const { roseStack } = roseSandboxIdentity();
  let killed = 0;
  for (const sandbox of await deps.list({ roseStack }, limit)) {
    // The provider filters by tag; re-check so a filter bug can never widen the kill.
    if (sandbox.metadata.roseStack !== roseStack) continue;
    try {
      await deps.kill(sandbox.sandboxId);
      killed += 1;
    } catch (error) {
      log.warn('Stack teardown could not kill a sandbox', {
        sandboxId: sandbox.sandboxId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  log.info('Stack sandboxes killed', { roseStack, killed: String(killed) });
  return killed;
}

/** Kill this stack's sandboxes whose code session is gone, retired or superseded. */
export async function reapOrphanedCodeSandboxes(
  deps: SandboxReaperDeps = defaultSandboxReaperDeps,
  opts: { maxSandboxes?: number; now?: Date } = {}
): Promise<{ scanned: number; reaped: number }> {
  const { roseStack } = roseSandboxIdentity();
  const now = opts.now ?? new Date();
  const listed = (await deps.list({ roseStack }, opts.maxSandboxes ?? 200)).filter(
    (sandbox) => sandbox.metadata.roseStack === roseStack && sandbox.metadata.codeSessionId
  );
  const rows = new Map(
    (
      await prisma.codeSession.findMany({
        where: { id: { in: [...new Set(listed.map((s) => s.metadata.codeSessionId))] } },
        select: { id: true, state: true, sandboxId: true },
      })
    ).map((row) => [row.id, row])
  );
  let reaped = 0;
  for (const sandbox of listed) {
    const row = rows.get(sandbox.metadata.codeSessionId);
    const superseded =
      row !== undefined &&
      row.sandboxId !== sandbox.sandboxId &&
      sandbox.state === 'paused' &&
      now.getTime() - sandbox.startedAt.getTime() > SUPERSEDED_GRACE_MS;
    if (row !== undefined && row.state !== 'RETIRED' && !superseded) continue;
    try {
      await deps.kill(sandbox.sandboxId);
      reaped += 1;
      log.info('Reaped orphaned code sandbox', {
        sandboxId: sandbox.sandboxId,
        codeSessionId: sandbox.metadata.codeSessionId,
        reason: row === undefined ? 'row_gone' : row.state === 'RETIRED' ? 'retired' : 'superseded',
      });
    } catch (error) {
      log.warn('Orphaned code sandbox kill failed; retried next tick', {
        sandboxId: sandbox.sandboxId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { scanned: listed.length, reaped };
}

export const CODE_SANDBOX_REAPER_LEASE_KEY = 'scheduled-job:code-sandbox-reaper';
const LEASE_TYPE = 'CODE_SANDBOX_REAPER_JOB_LEASE';
const LEASE_MS = 10 * 60 * 1000;

/** One replica per tick (same ToolSideEffect lease as the terminal browser release). */
export async function runCodeSandboxReaperWithLease(
  deps: SandboxReaperDeps = defaultSandboxReaperDeps
): Promise<{ acquired: boolean; scanned: number; reaped: number }> {
  const ownerId = randomUUID();
  const now = new Date();
  const rows = await prisma.$queryRaw<Array<{ externalId: string }>>(Prisma.sql`
    INSERT INTO "ToolSideEffect"
      (id, "operationKey", "operationType", status, "externalId", request, "createdAt", "updatedAt")
    VALUES
      (${randomUUID()}, ${CODE_SANDBOX_REAPER_LEASE_KEY}, ${LEASE_TYPE}, 'STARTED', ${ownerId},
       '{}'::jsonb, ${now}, ${now})
    ON CONFLICT ("operationKey") DO UPDATE SET
      status = 'STARTED', "externalId" = EXCLUDED."externalId", "updatedAt" = EXCLUDED."updatedAt"
    WHERE "ToolSideEffect".status <> 'STARTED'
       OR "ToolSideEffect"."updatedAt" <= ${new Date(now.getTime() - LEASE_MS)}
    RETURNING "externalId"
  `);
  if (rows[0]?.externalId !== ownerId) return { acquired: false, scanned: 0, reaped: 0 };
  try {
    return { acquired: true, ...(await reapOrphanedCodeSandboxes(deps)) };
  } finally {
    await prisma.toolSideEffect.updateMany({
      where: {
        operationKey: CODE_SANDBOX_REAPER_LEASE_KEY,
        status: 'STARTED',
        externalId: ownerId,
      },
      data: { status: 'RELEASED' },
    });
  }
}

/** Every 15 minutes on production: reap this deployment's orphaned code sandboxes (one replica per tick). */
export function scheduleCodeSandboxReaper(isProduction: boolean): void {
  if (!isProduction || process.env.DISABLE_CODE_SANDBOX_REAPER === '1') {
    log.info('Code sandbox reaper disabled', {
      reason: !isProduction ? 'non-production' : 'DISABLE_CODE_SANDBOX_REAPER',
    });
    return;
  }
  let running = false;
  cron.schedule('*/15 * * * *', () => {
    if (running) return;
    running = true;
    runCodeSandboxReaperWithLease()
      .then((summary) => {
        if (summary.reaped > 0) log.info('Code sandbox reaper summary', { ...summary });
      })
      .catch((error) => {
        log.error('Code sandbox reaper failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        running = false;
      });
  });
  log.info('Code sandbox reaper scheduled (every 15 minutes)');
}
