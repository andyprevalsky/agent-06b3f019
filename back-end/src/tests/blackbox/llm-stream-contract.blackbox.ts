#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
import { OPENAI_RESPONSES_API_URL } from '../../providers/rose/transport';
import { withIsolatedFundedKeyCooldowns } from './funded-key-cooldown.support';

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
  assert.equal(
    accumulator.currentText(),
    '',
    'currentText() is the degrade path and must not throw on ambiguous items'
  );
  assert.equal(accumulator.isAmbiguous(), true, 'two final_answer items are ambiguous');
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

async function main(): Promise<void> {
  await testSharedFixtures();
  testAmbiguousFinalItemsFailTyped();
  await withIsolatedFundedKeyCooldowns(testCompletionClientPreservesItemProvenance);
  console.log(`PASS llm-stream-contract (${fixtures.cases.length} shared provider fixtures)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
