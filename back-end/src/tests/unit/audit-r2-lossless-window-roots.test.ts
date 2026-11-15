#!/usr/bin/env tsx
/**
 * R2 lossless audit (V13) window scope, against the local unit database: the
 * window's roots are those created in it plus every older root whose tree (the
 * root itself or any descendant) recorded a ToolUsage row in it. A root whose
 * activity is all outside the window stays out.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { WINDOW_ROOTS_SQL } from '../../../scripts/audit-r2-lossless';

const SINCE = new Date('2026-11-14T00:00:00Z');
const UNTIL = new Date('2026-11-15T00:00:00Z');
const OLD = new Date('2026-11-01T00:00:00Z');

async function main(): Promise<void> {
  const userId = randomUUID();
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  const agent = async (name: string, createdAt: Date, parentAgentId?: string, depth = 0) =>
    (
      await prisma.agent.create({
        data: { userId, goal: name, createdAt, parentAgentId, depth },
        select: { id: true },
      })
    ).id;
  const usage = (agentId: string, createdAt: Date) =>
    prisma.toolUsage.create({
      data: { userId, agentId, toolName: 'planner', totalCostCents: 0, usageItems: [], createdAt },
    });
  try {
    const created = await agent('created in window', new Date('2026-11-14T05:00:00Z'));
    const longRunning = await agent('older root, grandchild calls in window', OLD);
    const child = await agent('child', OLD, longRunning, 1);
    const grandchild = await agent('grandchild', OLD, child, 2);
    await usage(grandchild, new Date('2026-11-14T03:00:00Z'));
    const direct = await agent('older root, own call in window', OLD);
    await usage(direct, new Date('2026-11-14T23:59:00Z'));
    const quiet = await agent('older root, activity outside window', OLD);
    const quietChild = await agent('quiet child', OLD, quiet, 1);
    await usage(quietChild, new Date('2026-11-13T12:00:00Z'));
    await usage(quietChild, UNTIL);

    const ids = [created, longRunning, child, grandchild, direct, quiet, quietChild];
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT a.id FROM "Agent" a WHERE a."parentAgentId" IS NULL AND a.id = ANY($3::text[])
         AND ${WINDOW_ROOTS_SQL}`,
      SINCE,
      UNTIL,
      ids
    );
    assert.deepEqual(rows.map((r) => r.id).sort(), [created, longRunning, direct].sort());
  } finally {
    await prisma.toolUsage.deleteMany({ where: { userId } });
    await prisma.agent.deleteMany({ where: { userId, parentAgentId: { not: null }, depth: 2 } });
    await prisma.agent.deleteMany({ where: { userId, parentAgentId: { not: null } } });
    await prisma.agent.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { userId } });
  }
  process.stdout.write('audit-r2-lossless-window-roots: all tests passed\n');
}

void main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
