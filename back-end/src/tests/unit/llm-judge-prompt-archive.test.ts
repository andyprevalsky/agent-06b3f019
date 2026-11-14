#!/usr/bin/env tsx
/**
 * LLM-judge-prompt generation archive (providers/openrouter.ts).
 *
 *   generateLLMJudgePrompt(goal, user-<uid> binding)
 *     ├─ call start ──► llm/<dump_id>          start record
 *     ├─ success    ──► llm-updates/<dump_id>  final record (output; returned_fallback when empty)
 *     └─ provider failure (prod path, no test fallback)
 *                   ──► llm-updates/<dump_id>  final record carrying the error, then rethrow
 *
 * A failed call must still close its start record so the lossless audit sees a
 * failed attempt, not a missing output.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { drainLlmCaptures } from '../../providers/llmCaptureTasks';
import {
  decryptAndValidateArtifact,
  listArchivedObjects,
  readArchivedArtifactStrict,
} from '../../providers/traceArchive';
import { archiveRecordSchemaErrors } from '../helpers/llmArchiveRecordSchema';

async function readRecords(
  rootId: string
): Promise<Array<{ path: string; record: Record<string, unknown> }>> {
  const objects = await listArchivedObjects(rootId, { throwOnError: true });
  const records = [];
  for (const object of objects.filter((item) => /^(llm|llm-updates)\//.test(item.path))) {
    const stored = await readArchivedArtifactStrict({
      rootAgentId: rootId,
      objectPath: object.path,
    });
    assert(stored);
    records.push({
      path: object.path,
      record: JSON.parse(decryptAndValidateArtifact(stored).toString('utf8')) as Record<
        string,
        unknown
      >,
    });
  }
  return records;
}

async function main(): Promise<void> {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-judge-prompt-archive-'));
  try {
    process.env.NODE_ENV = 'test';
    process.env.TRACE_ARCHIVE_ENABLED = 'true';
    process.env.TRACE_ARCHIVE_BACKEND = 'local';
    process.env.TRACE_ARCHIVE_LOCAL_DIR = directory;
    process.env.TRACE_ARCHIVE_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 7).toString('base64');
    process.env.OPENAI_API_KEY = 'judge-prompt-archive';
    // The production path: no blackbox fallback.
    delete process.env.BLACKBOX_TEST_CAPTURE_OUTBOUND;
    const { generateLLMJudgePrompt } = await import('../../providers/openrouter');

    // Provider failure: the caller sees the error and the archive gets a closed final record.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: 'boom' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const failedRoot = `user-${randomUUID()}`;
    await assert.rejects(
      generateLLMJudgePrompt('Book a table', { agent_id: failedRoot, root_agent_id: failedRoot })
    );
    await drainLlmCaptures([failedRoot]);
    const failed = await readRecords(failedRoot);
    assert.equal(failed.filter((item) => item.path.startsWith('llm/')).length, 1, 'start record');
    const failedFinal = failed.find((item) => item.path.startsWith('llm-updates/'));
    assert(failedFinal, 'a failed call must still write its final record');
    assert.deepEqual(archiveRecordSchemaErrors(failedFinal.record), []);
    const failedOutput = failedFinal.record.output as { content: string; error: unknown };
    assert.equal(failedOutput.content, '');
    assert(failedOutput.error, 'the final record carries the provider error');

    // Empty completion: the fallback the caller receives is recorded and flagged.
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          created: 1,
          model: 'gpt-4.1',
          choices: [
            { index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )) as typeof fetch;
    const emptyRoot = `user-${randomUUID()}`;
    const returned = await generateLLMJudgePrompt('Book a table', {
      agent_id: emptyRoot,
      root_agent_id: emptyRoot,
    });
    await drainLlmCaptures([emptyRoot]);
    const emptyFinal = (await readRecords(emptyRoot)).find((item) =>
      item.path.startsWith('llm-updates/')
    );
    assert(emptyFinal);
    assert.deepEqual(archiveRecordSchemaErrors(emptyFinal.record), []);
    assert.equal((emptyFinal.record.output as { content: string }).content, returned);
    assert.equal(
      (emptyFinal.record.extra as { returned_fallback?: boolean }).returned_fallback,
      true
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    fs.rmSync(directory, { recursive: true, force: true });
  }
  process.stdout.write('llm-judge-prompt-archive: all checks passed\n');
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
});
