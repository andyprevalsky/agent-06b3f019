#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { listArchivedObjects, readArchivedArtifactStrict } from '../../providers/traceArchive';
import { materializeArchiveLlmDumps } from '../../providers/archiveLlmMaterialization';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  StructuredOutputAccumulator,
  StructuredOutputCardinalityError,
} from '../../providers/rose/structuredOutput';
import {
  __resetAnthropicApiKeyCooldown,
  __resetGptApiKeyCooldown,
  createStreamingCompletion,
} from '../../providers/rose/client';
import {
  parseAnthropicSSE,
  parseOpenAISSE,
  parseResponsesSSE,
} from '../../providers/rose/streaming';
import type { CompletionMessage, RoseStreamChunk } from '../../providers/rose/types';
import { CEREBRAS_API_URL, OPENAI_RESPONSES_API_URL } from '../../providers/rose/transport';
import { buildRouterCompletionOptions } from '../../providers/chat/routerLlm';
import { buildGeneratorCompletionOptions } from '../../providers/chat/generatorLlm';
import { withIsolatedFundedKeyCooldowns } from './funded-key-cooldown.support';
import { callSupervisorLlm } from '../../providers/smsSupervisor/supervisorLlm';
import { markCacheable } from '../../providers/rose/cache';
import { transformMessagesForAnthropic } from '../../providers/rose/transforms';
import { buildEnvironmentToolMessages } from '../../providers/smsSupervisor/environmentMessages';
import { formatUserTemporalContext } from '../../providers/smsSupervisor/timeContext';
import { buildAnthropicBody } from '../../providers/rose/claudeAuth';
import { buildCodexResponsesBody } from '../../providers/rose/gptAuth';
import { buildOpenRouterCerebrasBody } from '../../providers/rose/openrouterCerebrasRoute';
import { buildOpenRouterFastChatBody } from '../../providers/rose/openrouterFastRoute';
import { getPool } from '../../providers/rose/pools';

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
    await __resetGptApiKeyCooldown();
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
    await __resetGptApiKeyCooldown();
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
        assert.deepEqual(dump.messages, JSON.parse(JSON.stringify(options.messages)));
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

async function testChatArchivedCompletionEvidence(): Promise<void> {
  const fixture = fixtures.cases.find((candidate) => candidate.format === 'openai_chat');
  assert(fixture);
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-archive-contract-'));
  let providerCalls = 0;
  try {
    process.env.CEREBRAS_API_KEY = 'contract-test-key';
    process.env.TRACE_ARCHIVE_ENABLED = 'true';
    process.env.TRACE_ARCHIVE_BACKEND = 'local';
    process.env.TRACE_ARCHIVE_LOCAL_DIR = directory;
    process.env.TRACE_ARCHIVE_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 7).toString('base64');
    global.fetch = async (input) => {
      assert.equal(String(input), CEREBRAS_API_URL);
      providerCalls += 1;
      return new Response(sseBody(fixture.sse_lines), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    };
    for (const mode of ['empty-fly', 'fly', 'render']) {
      process.env.NODE_ENV = mode === 'render' ? 'production' : 'test';
      if (mode === 'render') delete process.env.FLY_APP_NAME;
      else process.env.FLY_APP_NAME = mode === 'fly' ? 'contract-fly' : '';
      for (const buildOptions of [buildRouterCompletionOptions, buildGeneratorCompletionOptions]) {
        const agentId = randomUUID();
        const options = buildOptions({
          agentId,
          model: 'rose-labs/rose-1-lite',
          messages: [{ role: 'user', content: 'Return the contract fixture' }],
          providerRoute: 'direct-cerebras',
          providerFastMode: false,
        });
        assert(options.dump_context);
        options.dump_context.root_agent_id = agentId;
        const accumulator = new StructuredOutputAccumulator();
        for await (const chunk of await createStreamingCompletion(options)) {
          accumulator.addCompletionChunk(chunk);
        }
        assert.equal(accumulator.finalText(), fixture.expected_structured_content);
        assert.equal(
          fs.existsSync(path.join(repoRoot, '.llm-dumps', agentId)),
          false,
          `${mode} must never write plaintext dumps`
        );
        const recovered = await materializeArchiveLlmDumps(agentId, path.join(directory, agentId), {
          list: (root) => listArchivedObjects(root, { throwOnError: true }),
          read: (rootAgentId, objectPath) =>
            readArchivedArtifactStrict({ rootAgentId, objectPath }),
        });
        const dump = JSON.parse(fs.readFileSync(recovered.latest.path, 'utf8'));
        assert.equal(dump.root_agent_id, agentId);
        assert.equal(dump.agent_id, agentId);
        assert.deepEqual(dump.messages, JSON.parse(JSON.stringify(options.messages)));
        assert.deepEqual(dump.response_format, options.response_format);
        assert.deepEqual(dump.config.requested_params.provider_route, 'direct-cerebras');
        assert.equal(dump.extra.output, fixture.expected_structured_content);
        assert(dump.config.actual_model);
        assert(dump.dump_id);
      }
    }
    assert.equal(providerCalls, 6, 'archival never adds provider calls');
  } finally {
    global.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const originalEnv = { ...process.env };
  const archiveDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-contract-archive-'));
  try {
    process.env.TRACE_ARCHIVE_BACKEND = 'local';
    process.env.TRACE_ARCHIVE_LOCAL_DIR = archiveDirectory;
    await withIsolatedFundedKeyCooldowns(testChatArchivedCompletionEvidence);
    await testSharedFixtures();
    testAmbiguousFinalItemsFailTyped();
    await withIsolatedFundedKeyCooldowns(testCompletionClientPreservesItemProvenance);
    await withIsolatedFundedKeyCooldowns(() => testChatCompletionDumps());
    await withIsolatedFundedKeyCooldowns(() => testChatCompletionDumps(true));
    await withIsolatedFundedKeyCooldowns(testInteractiveClockGrounding);
    testInteractiveClockProviderCachePrefixes();
    console.log(`PASS llm-stream-contract (${fixtures.cases.length} shared provider fixtures)`);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    fs.rmSync(archiveDirectory, { recursive: true, force: true });
  }
}

/** Inspect provider bodies, including cache markers and Responses routing keys. */
function testInteractiveClockProviderCachePrefixes(): void {
  const messages: CompletionMessage[] = [
    markCacheable('cache-stable system prompt'),
    { role: 'user', content: 'Earlier question' },
    { role: 'assistant', content: 'Earlier answer' },
    { role: 'user', content: 'Continue with the current information.' },
  ];
  const options = buildRouterCompletionOptions({
    agentId: 'clock-cache-contract',
    model: 'rose-labs/rose-1-flash',
    messages,
    providerFastMode: true,
  });
  const poolSpec = getPool('rose-1-flash');
  const nativeBefore = buildAnthropicBody({ poolSpec, messages });
  const nativeAfter = buildAnthropicBody({ poolSpec, messages: options.messages });
  assert.deepEqual(
    nativeAfter.system,
    nativeBefore.system,
    'Anthropic system cache blocks stay identical'
  );
  assert.deepEqual(
    (nativeAfter.messages as unknown[]).slice(0, -1),
    nativeBefore.messages,
    'Anthropic preserves history content AND its existing cache breakpoint'
  );
  assert(
    !JSON.stringify((nativeAfter.messages as unknown[]).at(-1)).includes('cache_control'),
    'fresh clock remains beyond the history cache breakpoint'
  );

  const responseBefore = buildCodexResponsesBody({
    poolSpec,
    messages,
    requestId: 'clock-cache-contract',
  });
  const responseAfter = buildCodexResponsesBody({
    poolSpec,
    messages: options.messages,
    requestId: 'clock-cache-contract',
  });
  assert.equal(
    responseAfter.instructions,
    responseBefore.instructions,
    'Responses instructions stay identical'
  );
  assert.equal(
    responseAfter.prompt_cache_key,
    responseBefore.prompt_cache_key,
    'Responses cache routing key stays identical'
  );
  assert.deepEqual(
    (responseAfter.input as unknown[]).slice(0, -1),
    responseBefore.input,
    'Responses keeps all existing input before the clock'
  );
  assert(
    JSON.stringify((responseAfter.input as unknown[]).at(-1)).includes('<system-reminder>'),
    'Responses retains the clock'
  );
  for (const buildBody of [
    buildOpenRouterCerebrasBody,
    (params: typeof options) => buildOpenRouterFastChatBody(params, 'clock-cache-contract'),
  ]) {
    const before = buildBody({ ...options, messages });
    const after = buildBody(options);
    assert.deepEqual(
      (after.messages as unknown[]).slice(0, -1),
      before.messages,
      'OpenRouter keeps the full history prefix'
    );
    assert(
      JSON.stringify((after.messages as unknown[]).at(-1)).includes('<system-reminder>'),
      'OpenRouter retains the clock'
    );
  }
}

/** Exercise the real completion boundaries; replace only the provider HTTP response. */
async function testInteractiveClockGrounding(): Promise<void> {
  const originalFetch = global.fetch;
  const originalDate = globalThis.Date;
  const originalEnv = { ...process.env };
  const requests: Array<{ messages: CompletionMessage[] }> = [];
  const failures: unknown[] = [];
  let instant = '2026-10-16T19:57:35.000Z';
  class ClockDate extends originalDate {
    constructor(value?: string | number | Date) {
      super(value ?? instant);
    }
    static now(): number {
      return new originalDate(instant).getTime();
    }
  }
  process.env.CEREBRAS_API_KEY = 'contract-test-key';
  delete process.env.BENCHMARK_SMS_SUPERVISOR_MODEL;
  delete process.env.BENCHMARK_SMS_SUPERVISOR_ROUTE;
  delete process.env.BLACKBOX_SMS_SUPERVISOR_RESPONSE_JSON;
  global.fetch = async (input, init) => {
    assert.equal(String(input), CEREBRAS_API_URL, 'only the fixture provider may be called');
    requests.push(JSON.parse(String(init?.body)));
    const output = JSON.stringify({
      reasoning: 'recorded provider response',
      response: 'fixture',
      tool_calls: [{ tool: 'attempt_completion', arguments: {} }],
    });
    return new Response(
      sseBody([
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: output }, finish_reason: 'stop' }] })}`,
        'data: [DONE]',
      ]),
      { headers: { 'Content-Type': 'text/event-stream' } }
    );
  };
  const messages: CompletionMessage[] = [
    markCacheable('static interactive prompt'),
    { role: 'user', content: 'is codex open source? what parts of it are closed source?' },
    { role: 'assistant', content: 'Previously we discussed releases in 2025.' },
    { role: 'user', content: 'What is current? Also compare the 2025 release.' },
  ];
  const originalMessages = structuredClone(messages);
  try {
    globalThis.Date = ClockDate as DateConstructor;
    for (const nextInstant of ['2026-10-16T19:57:35.000Z', '2027-01-01T00:00:01.000Z']) {
      instant = nextInstant;
      for (const phase of [
        'initial',
        'after_search',
        'search_budget_spent',
        'generator',
        'sms',
        'reaction',
      ] as const) {
        try {
          const inputMessages =
            phase === 'sms' || phase === 'reaction'
              ? [
                  ...messages,
                  ...buildEnvironmentToolMessages(
                    formatUserTemporalContext(new Date(instant), 'America/Los_Angeles'),
                    1
                  ),
                ]
              : messages;
          const originalInput = structuredClone(inputMessages);
          if (phase === 'sms' || phase === 'reaction') {
            await callSupervisorLlm(inputMessages, null, 'clock-contract', phase === 'reaction');
          } else {
            const params = {
              agentId: 'clock-contract',
              model: 'rose-labs/rose-1-flash',
              messages: inputMessages,
              providerRoute: 'direct-cerebras' as const,
              providerFastMode: false,
            };
            const options =
              phase === 'generator'
                ? buildGeneratorCompletionOptions(params)
                : buildRouterCompletionOptions({ ...params, stage: phase });
            for await (const chunk of await createStreamingCompletion(options)) void chunk;
          }
          const sent = requests.at(-1)?.messages;
          assert(sent, `${phase}: provider request captured`);
          assert.equal(sent[0]?.role, 'system', `${phase}: static prompt precedes clock`);
          assert.equal(
            sent.filter((message) => message.role === 'system').length,
            1,
            'Cerebras accepts one system message'
          );
          assert.equal(sent[0]?.content, originalMessages[0].content, 'static prefix unchanged');
          assert.deepEqual(
            sent.slice(0, -1),
            originalInput,
            `${phase}: entire existing prompt and history remain the cacheable prefix`
          );
          assert(
            JSON.stringify(sent).startsWith(`${JSON.stringify(originalInput).slice(0, -1)},`),
            `${phase}: serialized provider message prefix is byte-identical`
          );
          const clock = sent.at(-1);
          assert.equal(clock?.role, 'user', `${phase}: runtime metadata follows history`);
          assert.match(String(clock?.content), /^<system-reminder>\n/);
          assert.match(String(clock?.content), /\n<\/system-reminder>$/);
          assert.equal(
            transformMessagesForAnthropic(sent).staticSystem,
            transformMessagesForAnthropic(originalMessages).staticSystem,
            'clock stays outside static cache prefix'
          );
          assert.match(
            String(clock?.content),
            new RegExp(`Current UTC time: ${instant.replaceAll('.', '\\.')}`),
            `${phase}: fresh UTC instant`
          );
          const expectedDate = nextInstant.startsWith('2026')
            ? 'Friday, October 16, 2026'
            : 'Friday, January 1, 2027';
          assert(
            String(clock?.content).includes(expectedDate),
            `${phase}: calendar date and weekday agree with clock`
          );
          assert(
            String(clock?.content).includes("user's local time"),
            `${phase}: UTC/local distinction`
          );
          assert.deepEqual(
            transformMessagesForAnthropic(sent).messages.slice(0, -1),
            transformMessagesForAnthropic(originalInput).messages,
            'Anthropic conversion preserves the entire conversation prefix'
          );
          assert.deepEqual(
            messages,
            originalMessages,
            'runtime clock never enters persisted input'
          );
          assert.deepEqual(
            inputMessages,
            originalInput,
            'SMS local-time environment remains intact'
          );
        } catch (error) {
          failures.push(new Error(`${phase} at ${instant}`, { cause: error }));
        }
      }
    }
    assert.equal(requests.length, 12, 'one provider request per inference');
    if (failures.length) throw new AggregateError(failures, 'interactive clock grounding');
  } finally {
    global.fetch = originalFetch;
    globalThis.Date = originalDate;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    fs.rmSync(path.join(repoRoot, '.llm-dumps', 'clock-contract'), {
      recursive: true,
      force: true,
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
