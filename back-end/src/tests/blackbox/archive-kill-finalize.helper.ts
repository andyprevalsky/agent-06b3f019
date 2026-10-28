/**
 * SMS kill_agent must not wait for the killed root's trace-archive finalization.
 *
 * Production 2026-10-27: an SMS "kill these agents" commit ran the root's R2
 * finalization (8,777 artifacts, ~12 minutes) inline inside the per-user SMS
 * commit lock, so the reply was never sent before the instance was replaced.
 * Holding the root's real manifest lock reproduces a long finalization at the
 * same await; the kill commit must still return promptly, and the durable
 * obligation must still finalize once the lock clears.
 */
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { waitForScheduledRootArchiveFinalizations } from '../../providers/agentKill';
import { prisma } from '../../providers/database';
import { commitPendingWrites } from '../../providers/smsSupervisor/supervisorTools';
import {
  inspectFinalizedManifest,
  withArchiveManifestLock,
} from '../../providers/traceArchiveManifest';
import { trackSeededRootAgent } from './archive-planner-memory.helper';

const KILL_COMMIT_BOUND_MS = 5_000;
const FINALIZE_AFTER_UNLOCK_BOUND_MS = 30_000;

function within<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function testSmsKillDoesNotAwaitRootArchiveFinalization(): Promise<void> {
  const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-kill-archive-'));
  const oldEnv = {
    TRACE_ARCHIVE_ENABLED: process.env.TRACE_ARCHIVE_ENABLED,
    TRACE_ARCHIVE_BACKEND: process.env.TRACE_ARCHIVE_BACKEND,
    TRACE_ARCHIVE_LOCAL_DIR: process.env.TRACE_ARCHIVE_LOCAL_DIR,
  };
  process.env.TRACE_ARCHIVE_ENABLED = '1';
  process.env.TRACE_ARCHIVE_BACKEND = 'local';
  process.env.TRACE_ARCHIVE_LOCAL_DIR = archiveDir;

  const userId = `sms-kill-archive-${randomUUID()}`;
  const rootAgentId = randomUUID();
  trackSeededRootAgent(rootAgentId);
  let releaseLock: () => void = () => {};
  const lockReleased = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  let lockHeld: () => void = () => {};
  const lockAcquired = new Promise<void>((resolve) => {
    lockHeld = resolve;
  });
  let holder: Promise<void> | null = null;
  let kill: Promise<unknown> | null = null;
  try {
    await prisma.user.create({
      data: { userId, phone: `+1552${String(Date.now()).slice(-7)}` },
    });
    await prisma.agent.create({
      data: {
        id: rootAgentId,
        userId,
        goal: 'sms kill archive finalization',
        status: 'ACTIVE',
        busId: rootAgentId,
        verifier: { create: {} },
      },
    });

    // A long-running finalization of this root holds its manifest lock.
    holder = withArchiveManifestLock(rootAgentId, async () => {
      lockHeld();
      await lockReleased;
    });
    await lockAcquired;

    const startedAt = Date.now();
    kill = commitPendingWrites(
      [
        {
          kind: 'kill_agent',
          args: { agent_id_or_prefix: rootAgentId.slice(0, 6) },
          agentId: rootAgentId,
        },
      ],
      userId
    );
    const outcome = await within(kill, KILL_COMMIT_BOUND_MS);
    assert.notStrictEqual(
      outcome,
      'timeout',
      `SMS kill_agent commit did not return within ${KILL_COMMIT_BOUND_MS}ms while the root ` +
        'archive finalization was still running; the user reply is blocked behind it'
    );
    const [result] = outcome as Array<{ success: boolean; error?: string }>;
    assert.strictEqual(result.success, true, `kill_agent commit failed: ${result.error ?? ''}`);
    console.log(`    kill_agent commit returned in ${Date.now() - startedAt}ms`);
    assert.ok(
      (await prisma.agent.findUniqueOrThrow({ where: { id: rootAgentId } })).deletedAt,
      'the kill must soft-delete the root before returning'
    );

    // The durable obligation is still discharged once the long finalization ends.
    releaseLock();
    await holder;
    assert.notStrictEqual(
      await within(waitForScheduledRootArchiveFinalizations(), FINALIZE_AFTER_UNLOCK_BOUND_MS),
      'timeout',
      'scheduled root archive finalization did not settle after the lock cleared'
    );
    const obligation = await prisma.traceArchiveFinalization.findUnique({
      where: { rootAgentId },
    });
    assert.strictEqual(
      obligation,
      null,
      `root archive finalization never completed after the kill (lastError=${obligation?.lastError ?? ''})`
    );
    assert.strictEqual((await inspectFinalizedManifest(rootAgentId)).status, 'current');
  } finally {
    releaseLock();
    await holder?.catch(() => undefined);
    await kill?.catch(() => undefined);
    await prisma.traceArchiveFinalization.deleteMany({ where: { rootAgentId } });
    await prisma.agentTrajectorySearch.deleteMany({ where: { rootAgentId } });
    await prisma.plannerMemory.deleteMany({ where: { id: rootAgentId } });
    await prisma.agent.deleteMany({ where: { id: rootAgentId } });
    await prisma.user.deleteMany({ where: { userId } });
    fs.rmSync(archiveDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
