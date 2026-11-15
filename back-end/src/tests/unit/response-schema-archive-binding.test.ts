#!/usr/bin/env tsx
/**
 * Schema-generation LLM calls are archived under a caller-owned root, never into
 * another user's bundle, with no root lookup before the model call.
 *
 *   POST /api/agents/generate-response-schema (generateSchema, caller uid) ─► user-<uid>
 *   setResponseSchema(child)  (internal, archive_scope {agentId})          ─► child's tree root
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { generateSchema } from '../../domains/agents/agentMessageLookupService';
import { setResponseSchema } from '../../providers/setResponseSchema';
import { __resetArchiveRootCache } from '../../providers/archiveRootResolver';
import { drainLlmCaptures } from '../../providers/llmCaptureTasks';
import {
  decryptAndValidateArtifact,
  listArchivedObjects,
  readArchivedArtifactStrict,
} from '../../providers/traceArchive';
import { archiveRecordSchemaErrors } from '../helpers/llmArchiveRecordSchema';

const SCHEMA_REPLY = JSON.stringify({
  reasoning: 'need the population',
  fields: [{ name: 'population', type: 'int' }],
});

function schemaResponse(): Response {
  const lines = [
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content: SCHEMA_REPLY }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
    })}`,
    'data: [DONE]',
  ];
  return new Response(new TextEncoder().encode(`${lines.join('\n\n')}\n\n`), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

async function schemaRecords(rootId: string): Promise<Array<Record<string, unknown>>> {
  const objects = await listArchivedObjects(rootId, { throwOnError: true });
  const records = [];
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
    assert.deepEqual(archiveRecordSchemaErrors(record), [], `${object.path} schema-valid`);
    records.push(record);
  }
  return records.filter((record) => record.call_site === 'response_schema_generation');
}

function assertStartAndFinal(
  records: Array<Record<string, unknown>>,
  agentId: string,
  rootId: string
): void {
  assert.deepEqual(records.map((record) => record.record).sort(), ['final', 'start']);
  for (const record of records) {
    assert.equal(record.agent_id, agentId);
    assert.equal(record.root_agent_id, rootId);
  }
}

async function main(): Promise<void> {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-archive-binding-'));
  const owner = `schema-owner-${randomUUID()}`;
  const root = randomUUID();
  const child = randomUUID();
  await prisma.user.create({ data: { userId: owner } });
  try {
    process.env.NODE_ENV = 'test';
    process.env.TRACE_ARCHIVE_ENABLED = 'true';
    process.env.TRACE_ARCHIVE_BACKEND = 'local';
    process.env.TRACE_ARCHIVE_LOCAL_DIR = directory;
    process.env.TRACE_ARCHIVE_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 5).toString('base64');
    process.env.OPENROUTER_API_KEY = 'schema-archive';
    process.env.CEREBRAS_API_KEY = 'schema-archive';
    __resetArchiveRootCache();
    globalThis.fetch = (async () => schemaResponse()) as typeof fetch;
    await prisma.agent.create({ data: { id: root, userId: owner, goal: 'root', busId: root } });
    await prisma.agent.create({
      data: { id: child, userId: owner, goal: 'child goal', parentAgentId: root, busId: root },
    });

    // Route path: the caller's own per-user root.
    const generated = await generateSchema('find the population of Tokyo', undefined, owner);
    assert.equal(generated.schema.fields[0]?.name, 'population');
    await drainLlmCaptures([`user-${owner}`]);
    assertStartAndFinal(await schemaRecords(`user-${owner}`), `user-${owner}`, `user-${owner}`);

    // Internal path: the agent's tree root (child → busId root), never the child id.
    await setResponseSchema(child);
    await drainLlmCaptures([child]);
    assertStartAndFinal(await schemaRecords(root), child, root);
    assert.deepEqual(await schemaRecords(child), [], 'never filed under the child id');
    const stored = await prisma.agent.findUnique({
      where: { id: child },
      select: { responseSchema: true },
    });
    assert(stored?.responseSchema, 'setResponseSchema still persists the schema');
    process.stdout.write('response-schema-archive-binding: all checks passed\n');
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    fs.rmSync(directory, { recursive: true, force: true });
    const dumpRoot = path.resolve(__dirname, '../../../..', '.llm-dumps');
    for (const id of [child, `user-${owner}`]) {
      fs.rmSync(path.join(dumpRoot, id), { recursive: true, force: true });
    }
    await prisma.agent.deleteMany({ where: { id: { in: [child, root] } } });
    await prisma.user.deleteMany({ where: { userId: owner } });
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
});
