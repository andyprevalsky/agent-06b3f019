#!/usr/bin/env tsx
/**
 * V2 archived LLM record contract for the TypeScript writer
 * (shared/llm-archive-record/record.schema.json).
 *
 *   createStreamingCompletion(dump_context bound to a root)
 *     ├─ call start ──► llm/<dump_id>          start record (inputs, before any provider byte)
 *     └─ stream end ──► llm-updates/<dump_id>-…  final record (output, usage incl. reasoning,
 *                                               reasoning blocks, losing race legs as attempts)
 *
 * Every written record must validate against the shared schema, and an unbound
 * root must be refused (no write) rather than filed under a placeholder bundle.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStreamingCompletion } from '../../providers/rose';
import { CEREBRAS_API_URL, OPENROUTER_API_URL } from '../../providers/rose/transport';
import {
  parseAnthropicSSE,
  parseOpenAISSE,
  parseResponsesSSE,
} from '../../providers/rose/streaming';
import {
  archiveOutputFromAccumulator,
  createStreamAccumulator,
  foldRoseChunk,
} from '../../providers/rose/completionChunks';
import type { RoseStreamChunk } from '../../providers/rose/types';
import {
  assertBoundArchiveId,
  buildFinalRecord,
  buildStartRecord,
  UnboundArchiveRootError,
  userArchiveRoot,
} from '../../providers/llmArchiveRecord';
import { drainLlmCaptures } from '../../providers/llmCaptureTasks';
import {
  decryptAndValidateArtifact,
  listArchivedObjects,
  readArchivedArtifactStrict,
} from '../../providers/traceArchive';
import { archiveRecordSchemaErrors } from '../helpers/llmArchiveRecordSchema';

function sse(lines: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`${lines.join('\n')}\n`));
      controller.close();
    },
  });
}

async function collect(stream: AsyncIterable<RoseStreamChunk>): Promise<RoseStreamChunk[]> {
  const chunks: RoseStreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

const parseOptions = { actualModel: 'test-model', poolName: 'test-pool', requestId: 'req-1' };
const identity = {
  call_site: 'archive_contract',
  agent_id: 'agent-1',
  root_agent_id: 'root-1',
  span_id: 'span-1',
  dump_id: 'dump-1',
};

function assertValid(record: unknown, label: string): void {
  const errors = archiveRecordSchemaErrors(record);
  assert.deepEqual(errors, [], `${label} must satisfy record.schema.json v2`);
}

async function testAnthropicThinkingSignaturesAndRedaction(): Promise<void> {
  const chunks = await collect(
    parseAnthropicSSE(
      sse([
        'data: {"type":"message_start","message":{"usage":{"input_tokens":11}}}',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me "}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"think."}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-abc"}}',
        'data: {"type":"content_block_stop","index":0}',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"redacted_thinking","data":"opaque-redacted"}}',
        'data: {"type":"content_block_stop","index":1}',
        'data: {"type":"content_block_start","index":2,"content_block":{"type":"text","text":""}}',
        'data: {"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"Answer"}}',
        'data: {"type":"content_block_stop","index":2}',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}',
      ]),
      parseOptions
    )
  );
  const blocks = chunks.filter((chunk) => chunk.kind === 'reasoning_block').map((c) => c.data);
  assert.deepEqual(blocks, [
    { type: 'anthropic_thinking', text: 'Let me think.', signature: 'sig-abc' },
    { type: 'anthropic_redacted_thinking', data: 'opaque-redacted' },
  ]);
  const acc = createStreamAccumulator(1);
  for (const chunk of chunks) foldRoseChunk(acc, chunk);
  const output = archiveOutputFromAccumulator(acc, undefined, 5);
  assert.equal(output.content, 'Answer');
  assert.equal(output.reasoning, 'Let me think.');
  assert.equal(output.usage.prompt, 11);
  assert.equal(output.usage.completion, 7);
  assertValid(buildFinalRecord(identity, { finished_at_ms: 5, model: 'm', output }), 'anthropic');
}

async function testOpenRouterReasoningDetailsAndReasoningTokens(): Promise<void> {
  const chunks = await collect(
    parseOpenAISSE(
      sse([
        'data: {"choices":[{"index":0,"delta":{"reasoning":"step ","reasoning_details":[{"type":"reasoning.text","text":"step ","index":0,"format":"anthropic-claude-v1"}]}}]}',
        'data: {"choices":[{"index":0,"delta":{"reasoning":"one","reasoning_details":[{"type":"reasoning.text","text":"one","signature":"or-sig","index":0}]}}]}',
        'data: {"choices":[{"index":0,"delta":{"reasoning_details":[{"type":"reasoning.encrypted","data":"enc-blob","index":1}]}}]}',
        'data: {"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":9,"total_tokens":12,"completion_tokens_details":{"reasoning_tokens":6}}}',
        'data: [DONE]',
      ]),
      parseOptions
    )
  );
  const blocks = chunks.filter((chunk) => chunk.kind === 'reasoning_block').map((c) => c.data);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, 'openrouter_reasoning_detail');
  assert.equal(blocks[0].text, 'step one');
  assert.equal(blocks[0].signature, 'or-sig');
  assert.equal(blocks[1].data, 'enc-blob');
  const usage = chunks.find((chunk) => chunk.kind === 'usage');
  assert.equal(usage?.kind === 'usage' ? usage.data.reasoning_tokens : null, 6);
}

async function testResponsesReasoningItems(): Promise<void> {
  const chunks = await collect(
    parseResponsesSSE(
      sse([
        'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"rs_1","type":"reasoning","encrypted_content":"gAAA-enc","summary":[{"type":"summary_text","text":"plan"}]}}',
        'data: {"type":"response.output_item.done","output_index":1,"item":{"id":"rs_2","type":"reasoning","summary":[{"type":"summary_text","text":"plain"}]}}',
        'data: {"type":"response.output_text.delta","delta":"hi"}',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":8,"total_tokens":13,"output_tokens_details":{"reasoning_tokens":4}}}}',
      ]),
      parseOptions
    )
  );
  const acc = createStreamAccumulator(1);
  for (const chunk of chunks) foldRoseChunk(acc, chunk);
  const output = archiveOutputFromAccumulator(acc, undefined, 2);
  assert.equal(output.codex_reasoning_items.length, 1);
  assert.equal(output.codex_reasoning_items[0].encrypted_content, 'gAAA-enc');
  assert.deepEqual(
    output.reasoning_blocks.map((block) => [block.type, block.id]),
    [
      ['openai_reasoning_item', 'rs_1'],
      ['openai_reasoning_item', 'rs_2'],
    ]
  );
  assert.equal(output.usage.reasoning, 4);
  assertValid(buildFinalRecord(identity, { finished_at_ms: 2, model: 'm', output }), 'responses');
}

function testUnboundRootsRefused(): void {
  for (const bad of ['', 'unbound', 'None', 'undefined', null, undefined]) {
    assert.throws(() => assertBoundArchiveId('root_agent_id', bad), UnboundArchiveRootError);
    assert.throws(
      () =>
        buildStartRecord(
          { ...identity, root_agent_id: bad as string },
          { started_at_ms: 1, model: null, message_count: 0, messages: [], config: {} }
        ),
      UnboundArchiveRootError
    );
  }
  assert.equal(userArchiveRoot('u1'), 'user-u1');
  assert.notDeepEqual(
    archiveRecordSchemaErrors({
      ...buildStartRecord(identity, {
        started_at_ms: 1,
        model: null,
        message_count: 0,
        messages: [],
        config: {},
      }),
      root_agent_id: 'unbound',
    }),
    [],
    'the shared schema itself rejects unbound roots'
  );
}

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

function delayedCompletion(
  content: string,
  firstContentMs: number,
  finishMs: number,
  signal: AbortSignal | undefined
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const first = setTimeout(
        () =>
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
              })}\n\n`
            )
          ),
        firstContentMs
      );
      const done = setTimeout(() => {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }, finishMs);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(first);
          clearTimeout(done);
          controller.error(new Error('losing provider cancelled'));
        },
        { once: true }
      );
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function testEndToEndRecordsAndRaceLosers(): Promise<void> {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-archive-record-'));
  const localDumpAgents: string[] = ['orphan-agent'];
  try {
    process.env.NODE_ENV = 'test';
    process.env.TRACE_ARCHIVE_ENABLED = 'true';
    process.env.TRACE_ARCHIVE_BACKEND = 'local';
    process.env.TRACE_ARCHIVE_LOCAL_DIR = directory;
    process.env.TRACE_ARCHIVE_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 9).toString('base64');
    process.env.OPENROUTER_API_KEY = 'archive-contract';
    process.env.CEREBRAS_API_KEY = 'archive-contract';
    process.env.CEREBRAS_CHAT_HEDGE_MS = '0';

    // 1) Exclusive OpenRouter call: start + final records, both schema-valid.
    let releaseProvider: () => void = () => undefined;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    globalThis.fetch = (async () => {
      await providerGate;
      return new Response(
        sse([
          'data: {"choices":[{"index":0,"delta":{"reasoning":"why","reasoning_details":[{"type":"reasoning.text","text":"why","signature":"s1","index":0}]}}]}',
          'data: {"choices":[{"index":0,"delta":{"content":"Hi there"},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6,"completion_tokens_details":{"reasoning_tokens":1}}}',
          'data: [DONE]',
        ]),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
      );
    }) as typeof fetch;
    const rootId = randomUUID();
    const childId = randomUUID();
    const storedPaths: string[] = [];
    localDumpAgents.push(childId);
    const stream = await createStreamingCompletion({
      model: 'rose-labs/rose-1-flash',
      provider_route: 'openrouter-waterfall',
      messages: [{ role: 'user', content: 'say hi' }],
      dump_context: {
        call_site: 'archive_contract',
        agent_id: childId,
        root_agent_id: rootId,
        on_record: (objectPath) => {
          storedPaths.push(objectPath);
        },
      },
    });
    const iterator = stream[Symbol.asyncIterator]();
    const firstChunk = iterator.next();
    // Crash safety: the start record exists while the provider has not answered.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await drainLlmCaptures([childId]);
    const beforeAnswer = await readRecords(rootId);
    assert.deepEqual(
      beforeAnswer.map((item) => item.record.record),
      ['start'],
      'start record is durable before the provider answers'
    );
    releaseProvider();
    await firstChunk;
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
      // drain
    }
    await drainLlmCaptures([childId]);
    const records = await readRecords(rootId);
    assert.deepEqual(
      [...storedPaths].sort(),
      records.map((item) => item.path).sort(),
      'on_record reports each record path once it is stored'
    );
    const start = records.find((item) => item.path.startsWith('llm/'));
    const final = records.find((item) => item.path.startsWith('llm-updates/'));
    assert(start && final, 'one start and one final record');
    assert.equal(records.length, 2);
    for (const item of records) assertValid(item.record, item.path);
    assert.equal(start.record.agent_id, childId);
    assert.equal(start.record.root_agent_id, rootId);
    assert.equal(final.record.dump_id, start.record.dump_id);
    assert.match(
      final.path,
      new RegExp(
        `^llm-updates/${String(start.record.dump_id)}-\\d+-archive_contract\\.json\\.gz\\.enc$`
      )
    );
    const output = final.record.output as Record<string, unknown>;
    assert.equal(output.content, 'Hi there');
    assert.equal(output.reasoning, 'why');
    assert.deepEqual(output.usage, {
      prompt: 4,
      completion: 2,
      total: 6,
      reasoning: 1,
      cache_creation: 0,
      cache_read: 0,
      finish_reason: 'stop',
    });
    assert.equal((output.reasoning_blocks as Array<{ signature: string }>)[0].signature, 's1');
    assert.equal(
      fs.existsSync(path.join(directory, 'trace-archive', 'unbound')),
      false,
      'no placeholder bundle is ever created'
    );

    // 2) Unbound root: the call still streams, nothing is archived.
    const unboundStream = await createStreamingCompletion({
      model: 'rose-labs/rose-1-flash',
      provider_route: 'openrouter-waterfall',
      messages: [{ role: 'user', content: 'say hi' }],
      dump_context: { call_site: 'archive_contract', agent_id: 'orphan-agent' },
    });
    for await (const chunk of unboundStream) void chunk;
    await drainLlmCaptures(['orphan-agent']);
    assert.deepEqual(
      fs.readdirSync(path.join(directory, 'trace-archive')).sort(),
      [rootId].sort(),
      'an unbound capture writes no bundle at all'
    );

    // 3) Rate-capped Cerebras → raced OpenRouter legs. GLM streams first but the
    //    structured reply latches on the first COMPLETED leg (Qwen). The losing
    //    GLM leg's tokens must be archived as a lost_race attempt.
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === CEREBRAS_API_URL) return new Response('{"message":"quota"}', { status: 429 });
      assert.equal(url, OPENROUTER_API_URL);
      const model = (JSON.parse(String(init?.body)) as { model: string }).model;
      if (model === 'qwen/qwen3.8-27b') {
        return delayedCompletion('{"response":"qwen"}', 150, 200, init?.signal ?? undefined);
      }
      return delayedCompletion('{"response":"glm partial', 20, 1500, init?.signal ?? undefined);
    }) as typeof fetch;
    const raceRoot = randomUUID();
    localDumpAgents.push(raceRoot);
    const raced = await createStreamingCompletion({
      model: 'rose-labs/rose-1-flash',
      provider_route: 'direct-cerebras',
      messages: [{ role: 'user', content: 'race' }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'race_reply',
          strict: true,
          schema: {
            type: 'object',
            properties: { response: { type: 'string' } },
            required: ['response'],
            additionalProperties: false,
          },
        },
      },
      dump_context: { call_site: 'archive_race', agent_id: raceRoot, root_agent_id: raceRoot },
    });
    let text = '';
    for await (const chunk of raced) text += chunk.choices[0]?.delta?.content ?? '';
    assert.equal(text, '{"response":"qwen"}');
    await drainLlmCaptures([raceRoot]);
    const raceFinal = (await readRecords(raceRoot)).find((item) =>
      item.path.startsWith('llm-updates/')
    );
    assert(raceFinal);
    assertValid(raceFinal.record, 'race final');
    const attempts = raceFinal.record.attempts as Array<{
      outcome: string;
      output: { content: string };
    }>;
    assert.equal(attempts.length, 1, 'the losing leg is archived');
    assert.equal(attempts[0].outcome, 'lost_race');
    assert.equal(attempts[0].output.content, '{"response":"glm partial');
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    fs.rmSync(directory, { recursive: true, force: true });
    const dumpRoot = path.resolve(__dirname, '../../../..', '.llm-dumps');
    for (const agentId of localDumpAgents) {
      fs.rmSync(path.join(dumpRoot, agentId), { recursive: true, force: true });
    }
  }
}

async function main(): Promise<void> {
  await testAnthropicThinkingSignaturesAndRedaction();
  await testOpenRouterReasoningDetailsAndReasoningTokens();
  await testResponsesReasoningItems();
  testUnboundRootsRefused();
  await testEndToEndRecordsAndRaceLosers();
  process.stdout.write('llm-archive-record: all checks passed\n');
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
});
