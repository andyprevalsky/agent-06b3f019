#!/usr/bin/env tsx
/**
 * Deferred archive root binding: a backend LLM call never waits on the archive
 * root lookup (archiveRootResolver.archiveBindingFor is a DB read).
 *
 *   rewriteNotification(child) ─► provider fetch + full stream     (root lookup still pending)
 *        └─ background: archiveBindingFor({agentId: child}) ─► busId root ─► start + final records
 *   archive_scope {userId}     ─► records under user-<userId>
 *   archive_scope binding nothing ─► refused loudly, no bundle written
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { createStreamingCompletion } from '../../providers/rose';
import { rewriteNotification } from '../../providers/smsSupervisor/notificationLlm';
import { __resetArchiveRootCache } from '../../providers/archiveRootResolver';
import { drainLlmCaptures } from '../../providers/llmCaptureTasks';
import {
  decryptAndValidateArtifact,
  listArchivedObjects,
  readArchivedArtifactStrict,
} from '../../providers/traceArchive';
import { archiveRecordSchemaErrors } from '../helpers/llmArchiveRecordSchema';

type ArchivedRecord = { path: string; record: Record<string, unknown> };

async function readRecords(rootId: string): Promise<ArchivedRecord[]> {
  const objects = await listArchivedObjects(rootId, { throwOnError: true });
  const records: ArchivedRecord[] = [];
  for (const object of objects.filter((item) => /^(llm|llm-updates)\//.test(item.path))) {
    const stored = await readArchivedArtifactStrict({
      rootAgentId: rootId,
      objectPath: object.path,
    });
    assert(stored);
    const record = JSON.parse(decryptAndValidateArtifact(stored).toString('utf8')) as Record<
      string,
      unknown
    >;
    records.push({ path: object.path, record });
  }
  return records;
}

function completionResponse(content: string): Response {
  const lines = [
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    })}`,
    'data: [DONE]',
  ];
  return new Response(new TextEncoder().encode(`${lines.join('\n\n')}\n\n`), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

async function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function assertBoundRecords(records: ArchivedRecord[], agentId: string, rootId: string): void {
  assert.deepEqual(records.map((item) => item.record.record).sort(), ['final', 'start']);
  for (const item of records) {
    assert.deepEqual(archiveRecordSchemaErrors(item.record), [], `${item.path} schema-valid`);
    assert.equal(item.record.agent_id, agentId);
    assert.equal(item.record.root_agent_id, rootId);
  }
}

async function main(): Promise<void> {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  const originalFindUnique = prisma.agent.findUnique;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-archive-deferred-'));
  const root = randomUUID();
  const child = randomUUID();
  const userId = randomUUID();
  try {
    process.env.NODE_ENV = 'test';
    process.env.TRACE_ARCHIVE_ENABLED = 'true';
    process.env.TRACE_ARCHIVE_BACKEND = 'local';
    process.env.TRACE_ARCHIVE_LOCAL_DIR = directory;
    process.env.TRACE_ARCHIVE_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 7).toString('base64');
    process.env.OPENROUTER_API_KEY = 'deferred-root';
    process.env.CEREBRAS_API_KEY = 'deferred-root';
    __resetArchiveRootCache();

    // The root lookup hangs until released: the call must not wait on it.
    let releaseLookup: () => void = () => undefined;
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    let lookups = 0;
    Object.assign(prisma.agent, {
      findUnique: async (args: { where: { id?: string } }) => {
        lookups += 1;
        await lookupGate;
        return args.where.id === child ? { busId: root, parentAgentId: root } : null;
      },
    });
    let providerCalls = 0;
    globalThis.fetch = (async () => {
      providerCalls += 1;
      return completionResponse('{"message":"Your task finished."}');
    }) as typeof fetch;

    // (a) The real call site completes while the root lookup is still pending.
    const message = await withDeadline(
      rewriteNotification([{ role: 'user', content: 'task finished' }], child),
      5_000,
      'the model call waited on the archive root lookup'
    );
    assert.equal(message, 'Your task finished.');
    assert(providerCalls >= 1, 'the provider was called before the root resolved');
    assert.equal(lookups, 1, 'the root lookup started in the background and is still pending');
    assert.deepEqual(await readRecords(root), [], 'nothing is written before the root is known');

    releaseLookup();
    await drainLlmCaptures([child]);
    const records = await readRecords(root);
    assertBoundRecords(records, child, root);
    assert(records.every((item) => item.record.call_site === 'sms_notification'));
    assert.deepEqual(await readRecords(child), [], 'never filed under the child id');

    // User-level scope: the documented per-user root, no lookup.
    const userStream = await createStreamingCompletion({
      model: 'rose-labs/rose-1-flash',
      provider_route: 'openrouter-waterfall',
      messages: [{ role: 'user', content: 'user level' }],
      dump_context: { call_site: 'deferred_user_scope', archive_scope: { userId } },
    });
    for await (const chunk of userStream) void chunk;
    await drainLlmCaptures([`user-${userId}`]);
    assertBoundRecords(await readRecords(`user-${userId}`), `user-${userId}`, `user-${userId}`);

    // (b) A scope that binds nothing is refused: the call streams, nothing is written.
    const unbound = await createStreamingCompletion({
      model: 'rose-labs/rose-1-flash',
      provider_route: 'openrouter-waterfall',
      messages: [{ role: 'user', content: 'unbound' }],
      dump_context: { call_site: 'deferred_unbound', archive_scope: { agentId: null } },
    });
    for await (const chunk of unbound) void chunk;
    await drainLlmCaptures(['unbound']);
    assert.deepEqual(
      fs.readdirSync(path.join(directory, 'trace-archive')).sort(),
      [root, `user-${userId}`].sort(),
      'an unbound scope writes no bundle at all'
    );
    process.stdout.write('llm-archive-deferred-root: all checks passed\n');
  } finally {
    Object.assign(prisma.agent, { findUnique: originalFindUnique });
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    fs.rmSync(directory, { recursive: true, force: true });
    const dumpRoot = path.resolve(__dirname, '../../../..', '.llm-dumps');
    for (const id of [child, `user-${userId}`, 'unbound']) {
      fs.rmSync(path.join(dumpRoot, id), { recursive: true, force: true });
    }
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
});
