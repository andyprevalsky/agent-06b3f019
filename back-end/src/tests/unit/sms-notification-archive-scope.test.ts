#!/usr/bin/env tsx
/**
 * A correction-path notification rewrite with no agent (e.g. notifyAgentCardSetup
 * sends without archiveRootAgentId) is archived under the per-user root.
 *
 *   deliverNotificationMessage({ userId, no agentId }) ─► rejected text ─► rewriteNotification
 *        └─ archive_scope { agentId: undefined, userId } ─► user-<userId> start + final records
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { deliverNotificationMessage } from '../../providers/smsSupervisor/notificationDelivery';
import { drainLlmCaptures } from '../../providers/llmCaptureTasks';
import {
  decryptAndValidateArtifact,
  listArchivedObjects,
  readArchivedArtifactStrict,
} from '../../providers/traceArchive';
import { archiveRecordSchemaErrors } from '../helpers/llmArchiveRecordSchema';

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

async function main(): Promise<void> {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-notification-scope-'));
  const userId = randomUUID();
  const root = `user-${userId}`;
  try {
    process.env.NODE_ENV = 'test';
    process.env.TRACE_ARCHIVE_ENABLED = 'true';
    process.env.TRACE_ARCHIVE_BACKEND = 'local';
    process.env.TRACE_ARCHIVE_LOCAL_DIR = directory;
    process.env.TRACE_ARCHIVE_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 7).toString('base64');
    process.env.OPENROUTER_API_KEY = 'notification-scope';
    process.env.CEREBRAS_API_KEY = 'notification-scope';
    globalThis.fetch = (async () =>
      completionResponse('{"message":"Finish AgentCard setup."}')) as typeof fetch;

    const sent: string[] = [];
    const result = await deliverNotificationMessage({
      channel: 'SMS',
      message: '',
      requiredLinks: [],
      userId,
      send: async (message) => {
        sent.push(message);
        return { success: true };
      },
    });
    assert.equal(result.success, true);
    assert.deepEqual(sent, ['Finish AgentCard setup.'], 'the corrected text was delivered');

    await drainLlmCaptures([root]);
    const objects = (await listArchivedObjects(root, { throwOnError: true })).filter((item) =>
      /^(llm|llm-updates)\//.test(item.path)
    );
    const records: Record<string, unknown>[] = [];
    for (const object of objects) {
      const stored = await readArchivedArtifactStrict({
        rootAgentId: root,
        objectPath: object.path,
      });
      assert(stored);
      records.push(
        JSON.parse(decryptAndValidateArtifact(stored).toString('utf8')) as Record<string, unknown>
      );
    }
    assert.deepEqual(records.map((record) => record.record).sort(), ['final', 'start']);
    for (const record of records) {
      assert.deepEqual(archiveRecordSchemaErrors(record), []);
      assert.equal(record.root_agent_id, root);
      assert.equal(record.call_site, 'sms_notification');
    }
    process.stdout.write('sms-notification-archive-scope: all checks passed\n');
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    fs.rmSync(directory, { recursive: true, force: true });
    const dumpRoot = path.resolve(__dirname, '../../../..', '.llm-dumps');
    fs.rmSync(path.join(dumpRoot, root), { recursive: true, force: true });
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
});
