import assert from 'node:assert/strict';
import { FakeClock } from '../helpers/waitFor';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { drainLlmCaptures, ownLlmCapture } from '../../providers/llmCaptureTasks';
import { listArchivedObjects, readArchivedArtifactStrict } from '../../providers/traceArchive';
import { materializeArchiveLlmDumps } from '../../providers/archiveLlmMaterialization';
import { StructuredOutputAccumulator } from '../../providers/rose/structuredOutput';
import { createStreamingCompletion } from '../../providers/rose/client';
import { CEREBRAS_API_URL } from '../../providers/rose/transport';
import { buildRouterCompletionOptions } from '../../providers/chat/routerLlm';
import { buildGeneratorCompletionOptions } from '../../providers/chat/generatorLlm';
import { archiveRecordSchemaErrors } from '../helpers/llmArchiveRecordSchema';
const repoRoot = path.resolve(__dirname, '../../../..');
const fixtures = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'shared/llm-stream-contract/fixtures.json'), 'utf8')
) as { cases: { format: string; sse_lines: string[]; expected_structured_content: string }[] };
function sseBody(lines: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`${lines.join('\n')}\n`));
      controller.close();
    },
  });
}
export async function testChatArchivedCompletionEvidence(consumerClose = false): Promise<void> {
  const fixture = fixtures.cases.find((candidate) => candidate.format === 'openai_chat');
  assert(fixture);
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-archive-contract-'));
  const originalFindAgent = prisma.agent.findUnique;
  let implicitLookups = 0;
  prisma.agent.findUnique = async () => {
    implicitLookups += 1;
    throw new Error('Completion capture must use its caller-bound root identity');
  };
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
      for (const [buildOptions, stage] of [
        [buildRouterCompletionOptions, 'initial'],
        [buildRouterCompletionOptions, 'after_search'],
        [buildGeneratorCompletionOptions, undefined],
      ] as const) {
        const agentId = randomUUID();
        const rootId = stage === 'after_search' ? randomUUID() : agentId;
        const options = buildOptions({
          agentId,
          rootAgentId: rootId,
          stage,
          model: 'rose-labs/rose-1-lite',
          messages: [{ role: 'user', content: 'Return the contract fixture' }],
          providerRoute: 'direct-cerebras',
          providerFastMode: false,
        });
        assert(options.dump_context);

        let expectedOutput = fixture.expected_structured_content;
        const stream = await createStreamingCompletion(options);
        const accumulator = new StructuredOutputAccumulator();
        if (consumerClose) {
          const iterator = stream[Symbol.asyncIterator]();
          const first = await iterator.next();
          assert.equal(first.done, false);
          expectedOutput = first.value.choices[0]?.delta.content ?? '';
          await iterator.return?.();
        } else {
          for await (const chunk of stream) accumulator.addCompletionChunk(chunk);
          assert.equal(accumulator.finalText(), expectedOutput);
        }
        assert.equal(
          fs.existsSync(path.join(repoRoot, '.llm-dumps', agentId)),
          false,
          `${mode} must never write plaintext dumps`
        );
        await drainLlmCaptures([agentId]);
        const recovered = await materializeArchiveLlmDumps(rootId, path.join(directory, agentId), {
          list: (root) => listArchivedObjects(root, { throwOnError: true }),
          read: (rootAgentId, objectPath) =>
            readArchivedArtifactStrict({ rootAgentId, objectPath }),
        });
        const dump = JSON.parse(fs.readFileSync(recovered.latest.path, 'utf8'));
        assert.equal(dump.root_agent_id, rootId);
        // v2: a crash-safe start record (llm/) plus one final record (llm-updates/).
        assert.equal(recovered.baseCallCount, 1);
        assert.equal(recovered.updateCount, 1);
        for (const source of recovered.sources) {
          assert.deepEqual(
            archiveRecordSchemaErrors(source.payload),
            [],
            `${source.path} must satisfy shared/llm-archive-record/record.schema.json`
          );
        }
        assert.deepEqual(
          recovered.sources.map((source) => source.payload.record),
          ['start', 'final']
        );
        assert.equal(dump.agent_id, agentId);
        assert.deepEqual(dump.messages, JSON.parse(JSON.stringify(options.messages)));
        assert.deepEqual(dump.response_format, options.response_format);
        assert.deepEqual(dump.config.requested_params.provider_route, 'direct-cerebras');
        assert.equal(dump.output.content, expectedOutput);
        assert.equal(typeof dump.output.usage, 'object');
        if (consumerClose) assert.equal(dump.extra.consumer_closed, true);
        assert(dump.output.actual_model);
        assert(dump.dump_id);
      }
    }
    const chronologyRoot = randomUUID();
    const chronologyIterators: AsyncIterator<unknown>[] = [];
    const open = async (content: string) => {
      const options = buildGeneratorCompletionOptions({
        agentId: chronologyRoot,
        rootAgentId: chronologyRoot,
        model: 'rose-labs/rose-1-lite',
        messages: [{ role: 'user', content }],
        providerRoute: 'direct-cerebras',
        speed: 'standard',
      });
      assert(options.dump_context);
      options.dump_context.root_agent_id = chronologyRoot;
      const stream = await createStreamingCompletion(options);
      const iterator = stream[Symbol.asyncIterator]();
      chronologyIterators.push(iterator);
      assert.equal((await iterator.next()).done, false);
      return iterator;
    };
    const clock = new FakeClock();
    const originalNow = Date.now;
    const recordedOlderStart = clock.now();
    Date.now = () => clock.now();
    try {
      const older = await open('Older offline call fixture');
      clock.advance(1);
      const newer = await open('Newer offline call fixture');
      await newer.return?.();
      await drainLlmCaptures([chronologyRoot]);
      clock.advance(1);
      await older.return?.();
      await drainLlmCaptures([chronologyRoot]);
      const chronology = await materializeArchiveLlmDumps(
        chronologyRoot,
        path.join(directory, 'chronology'),
        {
          list: (root) => listArchivedObjects(root, { throwOnError: true }),
          read: (rootAgentId, objectPath) =>
            readArchivedArtifactStrict({ rootAgentId, objectPath }),
        }
      );
      assert.equal(chronology.baseCallCount, 2);
      assert.deepEqual(
        chronology.calls.map((call) => call.recordedCreatedAtMs),
        [recordedOlderStart, recordedOlderStart + 1],
        'archive timestamps must be captured at real call start, before reversed finishes'
      );
      const latest = JSON.parse(fs.readFileSync(chronology.latest.path, 'utf8'));
      assert.equal(
        latest.messages[0].content,
        'Newer offline call fixture',
        'latest call follows recorded start clock despite reverse completion order'
      );
    } finally {
      try {
        await Promise.allSettled(chronologyIterators.map((iterator) => iterator.return?.()));
        await Promise.allSettled([drainLlmCaptures([chronologyRoot])]);
      } finally {
        Date.now = originalNow;
      }
    }
    assert.equal(providerCalls, 11, 'archival never adds provider calls');
    assert.equal(implicitLookups, 0, 'capture must not open database pools in completion clients');
  } finally {
    global.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    prisma.agent.findUnique = originalFindAgent;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/** A root finalizer must observe capture failure even outside its parent-ID inventory. */
export async function testCaptureRootFailureOwnership(): Promise<void> {
  const rootId = randomUUID();
  const agentId = randomUUID();
  const failure = new Error('explicit-root failed capture fixture');
  ownLlmCapture(agentId, Promise.reject(failure), rootId);
  await new Promise((resolve) => setImmediate(resolve));
  for (const ids of [[rootId], [rootId], [agentId]]) {
    await assert.rejects(
      () => drainLlmCaptures(ids),
      (error: unknown) => error instanceof Error && error.cause === failure
    );
  }
}
