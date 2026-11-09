import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { drainLlmCaptures } from '../../providers/llmCaptureTasks';
import { listArchivedObjects, readArchivedArtifactStrict } from '../../providers/traceArchive';
import { materializeArchiveLlmDumps } from '../../providers/archiveLlmMaterialization';
import { StructuredOutputAccumulator } from '../../providers/rose/structuredOutput';
import { createStreamingCompletion } from '../../providers/rose/client';
import { CEREBRAS_API_URL } from '../../providers/rose/transport';
import { buildRouterCompletionOptions } from '../../providers/chat/routerLlm';
import { buildGeneratorCompletionOptions } from '../../providers/chat/generatorLlm';
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
  const roots = new Map<string, string>();
  let waitForRoot: Promise<void> = Promise.resolve();
  prisma.agent.findUnique = async (args) => {
    const root = args.where.id && roots.get(args.where.id);
    if (root) {
      await waitForRoot;
      return { busId: root } as Awaited<ReturnType<typeof originalFindAgent>>;
    }
    return originalFindAgent.call(prisma.agent, args);
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
        roots.set(agentId, rootId);
        let releaseRoot = () => {};
        waitForRoot = new Promise<void>((resolve) => {
          releaseRoot = resolve;
        });
        const options = buildOptions({
          agentId,
          stage,
          model: 'rose-labs/rose-1-lite',
          messages: [{ role: 'user', content: 'Return the contract fixture' }],
          providerRoute: 'direct-cerebras',
          providerFastMode: false,
        });
        assert(options.dump_context);
        if (stage === undefined) options.dump_context.root_agent_id = rootId;
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
        let drained = false;
        const drain = drainLlmCaptures([agentId]).then(() => {
          drained = true;
        });
        await Promise.resolve();
        if (stage !== undefined)
          assert.equal(drained, false, 'terminal owner waits for pending archive');
        const callsBeforeDrain = providerCalls;
        releaseRoot();
        await drain;
        assert.equal(
          providerCalls,
          callsBeforeDrain,
          'archive drain never starts a late provider call'
        );
        const recovered = await materializeArchiveLlmDumps(rootId, path.join(directory, agentId), {
          list: (root) => listArchivedObjects(root, { throwOnError: true }),
          read: (rootAgentId, objectPath) =>
            readArchivedArtifactStrict({ rootAgentId, objectPath }),
        });
        const dump = JSON.parse(fs.readFileSync(recovered.latest.path, 'utf8'));
        assert.equal(dump.root_agent_id, rootId);
        assert.equal(recovered.baseCallCount, 1);
        assert.equal(recovered.updateCount, 0);
        assert.equal(dump.agent_id, agentId);
        assert.deepEqual(dump.messages, JSON.parse(JSON.stringify(options.messages)));
        assert.deepEqual(dump.response_format, options.response_format);
        assert.deepEqual(dump.config.requested_params.provider_route, 'direct-cerebras');
        assert.equal(dump.extra.output, expectedOutput);
        if (consumerClose) assert.equal(dump.extra.consumer_closed, true);
        assert(dump.config.actual_model);
        assert(dump.dump_id);
      }
    }
    assert.equal(providerCalls, 9, 'archival never adds provider calls');
  } finally {
    global.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    prisma.agent.findUnique = originalFindAgent;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
