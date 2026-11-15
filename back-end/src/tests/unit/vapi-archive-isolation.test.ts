#!/usr/bin/env tsx
/**
 * A placed Vapi call's archive bookkeeping never withholds its call id.
 *
 *   placeCall ✓ ─► archivePlacedCall
 *                    ├─ root memo write rejects (DB down) ─► logged; create record still archived
 *                    └─ root lookup rejects (agent key)   ─► logged; resolves (no throw)
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { archivePlacedCall } from '../../domains/vapi/service';
import { __resetArchiveRootCache } from '../../providers/archiveRootResolver';
import { VAPI_CALL_OPERATION_TYPE } from '../../providers/vapiRecordings';
import { listArchivedObjects } from '../../providers/traceArchive';

async function main(): Promise<void> {
  const originalEnv = { ...process.env };
  const originalExecuteRaw = prisma.$executeRaw;
  const originalFindUnique = prisma.agent.findUnique;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vapi-archive-isolation-'));
  try {
    process.env.NODE_ENV = 'test';
    process.env.TRACE_ARCHIVE_ENABLED = 'true';
    process.env.TRACE_ARCHIVE_BACKEND = 'local';
    process.env.TRACE_ARCHIVE_LOCAL_DIR = directory;
    process.env.TRACE_ARCHIVE_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 7).toString('base64');
    __resetArchiveRootCache();
    const dbDown = async () => {
      throw new Error('database unavailable');
    };
    Object.assign(prisma, { $executeRaw: dbDown });
    Object.assign(prisma.agent, { findUnique: dbDown });

    // (1) No idempotency key, user known: the root memo write fails, the call
    // archive still lands and nothing is thrown.
    const userId = randomUUID();
    const callId = `call-${randomUUID()}`;
    await archivePlacedCall(
      { userId },
      { callId, request: { to: '+1555' }, response: { id: callId } }
    );
    const objects = await listArchivedObjects(`user-${userId}`, { throwOnError: true });
    assert(
      objects.some((item) => item.path.startsWith(`provider/vapi/${callId}.create`)),
      'the create record is archived even though the root memo write failed'
    );

    // (2) Agent-keyed call whose root lookup fails: resolves without throwing.
    const agentId = randomUUID();
    await archivePlacedCall(
      { operationKey: `${VAPI_CALL_OPERATION_TYPE}:${agentId}:key`, userId },
      { callId: `call-${randomUUID()}`, request: {}, response: {} }
    );
    process.stdout.write('vapi-archive-isolation: all checks passed\n');
  } finally {
    Object.assign(prisma, { $executeRaw: originalExecuteRaw });
    Object.assign(prisma.agent, { findUnique: originalFindUnique });
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    fs.rmSync(directory, { recursive: true, force: true });
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
});
