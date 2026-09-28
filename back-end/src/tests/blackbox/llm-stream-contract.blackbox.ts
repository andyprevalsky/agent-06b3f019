#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  StructuredOutputAccumulator,
  StructuredOutputCardinalityError,
} from '../../providers/rose/structuredOutput';
import {
  __resetAnthropicApiKeyCooldown,
  createStreamingCompletion,
} from '../../providers/rose/client';
import {
  parseAnthropicSSE,
  parseOpenAISSE,
  parseResponsesSSE,
} from '../../providers/rose/streaming';
import type { RoseStreamChunk } from '../../providers/rose/types';
import { CEREBRAS_API_URL, OPENAI_RESPONSES_API_URL } from '../../providers/rose/transport';
import { buildRouterCompletionOptions } from '../../providers/chat/routerLlm';
import { buildGeneratorCompletionOptions } from '../../providers/chat/generatorLlm';

type ProviderFormat = 'anthropic' | 'openai_chat' | 'openai_responses';

interface ContractCase {
  name: string;
  format: ProviderFormat;
  sse_lines: string[];
  expected_chunks: RoseStreamChunk[];
  expected_structured_content: string;
}

interface ContractFixtures {
  contract_version: number;
  content_provenance_fields: string[];
  cases: ContractCase[];
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const fixtures = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'shared/llm-stream-contract/fixtures.json'), 'utf8')
) as ContractFixtures;

function sseBody(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`${lines.join('\n')}\n`));
      controller.close();
    },
  });
}

async function parseFixture(testCase: ContractCase): Promise<RoseStreamChunk[]> {
  const options = {
    actualModel: 'contract-test-model',
    poolName: 'contract-test-pool',
    requestId: `contract-${testCase.name}`,
  };
  const body = sseBody(testCase.sse_lines);
  const stream =
    testCase.format === 'anthropic'
      ? parseAnthropicSSE(body, options)
      : testCase.format === 'openai_chat'
        ? parseOpenAISSE(body, options)
        : parseResponsesSSE(body, options);
  const chunks: RoseStreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

async function testSharedFixtures(): Promise<void> {
  assert.equal(fixtures.contract_version, 1);
  assert.deepEqual(fixtures.content_provenance_fields, [
    'item_id',
    'output_index',
    'content_index',
    'phase',
  ]);

  for (const testCase of fixtures.cases) {
    const chunks = await parseFixture(testCase);
    assert.deepEqual(
      chunks.filter((chunk) => chunk.kind !== 'metadata'),
      testCase.expected_chunks,
      `${testCase.name} normalized chunks`
    );

    const accumulator = new StructuredOutputAccumulator();
    for (const chunk of chunks) accumulator.addChunk(chunk);
    assert.equal(
      accumulator.finalText(),
      testCase.expected_structured_content,
      `${testCase.name} structured output`
    );
  }
}

function testAmbiguousFinalItemsFailTyped(): void {
  const accumulator = new StructuredOutputAccumulator();
  accumulator.addChunk({
    kind: 'content',
    data: {
      text: '{"answer":"one"}',
      item_id: 'final-1',
      output_index: 0,
      content_index: 0,
      phase: 'final_answer',
    },
  });
  accumulator.addChunk({
    kind: 'content',
    data: {
      text: '{"answer":"two"}',
      item_id: 'final-2',
      output_index: 1,
      content_index: 0,
      phase: 'final_answer',
    },
  });

  assert.throws(() => accumulator.finalText(), StructuredOutputCardinalityError);
}

async function testCompletionClientPreservesItemProvenance(): Promise<void> {
  const testCase = fixtures.cases.find((candidate) => candidate.format === 'openai_responses');
  assert(testCase);
  const originalFetch = global.fetch;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const originalGptKey = process.env.GPT_API_KEY;
  const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
  const originalCerebrasKey = process.env.CEREBRAS_API_KEY;
  // rose-fast skips funded OpenAI/Anthropic keys and hops Cerebras first.
  // Provenance through the Responses API is an Ultra / direct-auth contract.
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.GPT_API_KEY = 'test-openai-key';
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CEREBRAS_API_KEY;
  global.fetch = async (input) => {
    assert.equal(String(input), OPENAI_RESPONSES_API_URL);
    return new Response(sseBody(testCase.sse_lines), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  };

  try {
    await __resetAnthropicApiKeyCooldown();
    const stream = await createStreamingCompletion({
      model: 'rose-labs/rose-1-ultra',
      messages: [{ role: 'user', content: 'Return structured output' }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'contract_test',
          strict: true,
          schema: {
            type: 'object',
            properties: { answer: { type: 'string' } },
            required: ['answer'],
            additionalProperties: false,
          },
        },
      },
    });
    const accumulator = new StructuredOutputAccumulator();
    for await (const chunk of stream) accumulator.addCompletionChunk(chunk);
    assert.equal(accumulator.finalText(), testCase.expected_structured_content);
  } finally {
    global.fetch = originalFetch;
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
    if (originalGptKey === undefined) delete process.env.GPT_API_KEY;
    else process.env.GPT_API_KEY = originalGptKey;
    if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    if (originalCerebrasKey === undefined) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = originalCerebrasKey;
  }
}

async function testChatCompletionDumps(consumerClose = false): Promise<void> {
  const fixture = fixtures.cases.find((candidate) => candidate.format === 'openai_chat');
  assert(fixture);
  const originalFetch = global.fetch;
  const originalKey = process.env.CEREBRAS_API_KEY;
  process.env.CEREBRAS_API_KEY = 'contract-test-key';
  let providerCalls = 0;
  global.fetch = async (input) => {
    assert.equal(String(input), CEREBRAS_API_URL);
    providerCalls += 1;
    return new Response(sseBody(fixture.sse_lines), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  };
  const failures: unknown[] = [];
  try {
    for (const [callSite, buildOptions] of [
      ['chat_router', buildRouterCompletionOptions],
      ['chat_generator', buildGeneratorCompletionOptions],
    ] as const) {
      const agentId = randomUUID();
      const dumpDir = path.join(repoRoot, '.llm-dumps', agentId);
      const messages = [{ role: 'user' as const, content: 'Return the contract fixture' }];
      try {
        const options = buildOptions({
          agentId,
          model: 'rose-labs/rose-1-lite',
          messages,
          providerRoute: 'direct-cerebras',
          providerFastMode: false,
        });
        let expectedOutput = fixture.expected_structured_content;
        const stream = await createStreamingCompletion(options);
        if (consumerClose) {
          const iterator = stream[Symbol.asyncIterator]();
          const first = await iterator.next();
          assert.equal(first.done, false);
          expectedOutput = first.value.choices[0]?.delta.content ?? '';
          await iterator.return?.();
        } else {
          const accumulator = new StructuredOutputAccumulator();
          for await (const chunk of stream) accumulator.addCompletionChunk(chunk);
          assert.equal(accumulator.finalText(), expectedOutput);
        }
        assert(fs.existsSync(dumpDir), `${callSite} must capture its agent's completion`);
        const files = fs.readdirSync(dumpDir);
        assert.equal(files.length, 1, `${callSite} must capture once`);
        const dump = JSON.parse(fs.readFileSync(path.join(dumpDir, files[0]), 'utf8'));
        assert.equal(dump.agent_id, agentId);
        assert.equal(dump.call_site, callSite);
        assert.deepEqual(dump.messages, messages);
        assert.deepEqual(dump.response_format, options.response_format);
        assert.equal(dump.extra.output, expectedOutput);
        if (consumerClose) assert.equal(dump.extra.consumer_closed, true);
      } catch (error) {
        failures.push(error);
      } finally {
        fs.rmSync(dumpDir, { recursive: true, force: true });
      }
    }
    assert.equal(providerCalls, 2, 'capture must not add any provider calls');
    if (failures.length) throw new AggregateError(failures, 'chat completion evidence missing');
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = originalKey;
  }
}

async function main(): Promise<void> {
  await testSharedFixtures();
  testAmbiguousFinalItemsFailTyped();
  await testCompletionClientPreservesItemProvenance();
  await testChatCompletionDumps();
  await testChatCompletionDumps(true);
  console.log(`PASS llm-stream-contract (${fixtures.cases.length} shared provider fixtures)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
