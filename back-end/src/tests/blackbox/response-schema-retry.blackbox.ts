#!/usr/bin/env tsx
/** Captured schema-author rejection must change the next provider request. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { drainLlmCaptures } from '../../providers/llmCaptureTasks';
import { join } from 'node:path';
import {
  decryptAndValidateArtifact,
  listArchivedObjects,
  readArchivedArtifact,
} from '../../providers/traceArchive';
import {
  generateResponseSchema,
  RESPONSE_SCHEMA_JSON_SCHEMA,
  parseGeneratedResponseSchemaJson,
} from '../../providers/setResponseSchema';

const captured = JSON.parse(
  readFileSync(new URL('./fixtures/schema-selection-mismatch.json', import.meta.url), 'utf8')
) as { content: string };
const correction = JSON.parse(
  readFileSync(new URL('./fixtures/schema-selection-correction.json', import.meta.url), 'utf8')
) as { content: string };
let recover = false;
let truncate = false;
let fatalStatus: number | undefined;
const archiveDir = mkdtempSync(join(tmpdir(), 'rose-schema-retry-'));
const originalFetch = globalThis.fetch;
const requests: Array<{
  messages: Array<{ role: string; content: string }>;
  max_completion_tokens: number;
}> = [];
process.env.CEREBRAS_API_KEY = 'test-schema-retry';
process.env.TRACE_ARCHIVE_ENABLED = '0';

globalThis.fetch = async (_url, init) => {
  if (String(_url).includes('/foundry-deployment/cooldown')) {
    return new Response(JSON.stringify({ cooldowns: {} }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const body = JSON.parse(String(init?.body)) as (typeof requests)[number];
  requests.push(body);
  if (fatalStatus)
    return new Response(JSON.stringify({ error: { message: 'fatal control' } }), {
      status: fatalStatus,
    });
  const limited = truncate && requests.length === 2;
  const feedback = body.messages.at(-1)?.content;
  const content = limited
    ? '{'
    : recover && feedback?.startsWith('Response schema failed schema:')
      ? correction.content
      : captured.content;
  return new Response(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: limited ? 'length' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`,
    { headers: { 'Content-Type': 'text/event-stream' } }
  );
};

async function main(): Promise<void> {
  // Equal accepted values expressed using the common provider subset, not const-only nodes.
  const variants = RESPONSE_SCHEMA_JSON_SCHEMA.properties.presentation.anyOf;
  assert.equal(JSON.stringify(variants).includes('"const"'), false);
  assert.deepEqual(variants[1].properties?.version, {
    type: 'integer',
    enum: [1],
  });
  assert.deepEqual(variants[2].properties?.encoding, {
    type: 'string',
    enum: ['text', 'json'],
  });
  assert.throws(
    () => parseGeneratedResponseSchemaJson(captured.content),
    /Value presentation must select/
  );
  // Even after feedback, persistently malformed completions must fail closed.
  await assert.rejects(
    generateResponseSchema('find the population of Tokyo'),
    /Value presentation must select/
  );
  assert.equal(requests.length, 3, 'existing attempt budget is unchanged');
  const first = requests[0].messages;
  assert.equal(first.length, 2);
  for (const request of requests.slice(1)) {
    assert.deepEqual(request.messages.slice(0, 2), first, 'original goal and policy preserved');
    assert.deepEqual(request.messages[2], {
      role: 'assistant',
      content: captured.content,
    });
    assert.match(request.messages[3].content, /Value presentation must select/);
    assert.notDeepEqual(
      request,
      requests[0],
      'semantic retry cannot replay the original cache key'
    );
  }
  requests.length = 0;
  recover = true;
  const result = await generateResponseSchema('find the population of Tokyo');
  assert.equal(requests.length, 2, 'captured rejection followed by its recorded correction');
  assert.deepEqual(requests[1].messages[2], {
    role: 'assistant',
    content: captured.content,
  });
  assert.equal(result.schema.fields[0].name, 'tokyo_population');
  assert.deepEqual(result.schema.presentation, {
    version: 1,
    mode: 'value',
    field: 'tokyo_population',
    encoding: 'text',
  });
  for (const field of [
    { name: 'population', type: 'int', required: false },
    { name: 'population', type: 'file_pointer', required: true },
    { name: 'population', type: 'list[int]', required: true },
  ]) {
    assert.throws(
      () =>
        parseGeneratedResponseSchemaJson(
          JSON.stringify({
            reasoning: 'invalid selection',
            fields: [field],
            presentation: {
              version: 1,
              mode: 'value',
              field: 'population',
              encoding: 'text',
            },
          })
        ),
      /Value presentation must select|at least one required/
    );
  }
  for (const fields of [
    [
      { name: 'population', type: 'int', required: true },
      { name: 'other', type: 'str', required: true },
    ],
    [
      {
        name: 'population',
        type: 'object',
        required: true,
        properties: [{ name: 'file', type: 'file_pointer', required: true }],
      },
    ],
  ]) {
    assert.throws(
      () =>
        parseGeneratedResponseSchemaJson(
          JSON.stringify({
            reasoning: 'invalid selection',
            fields,
            presentation: {
              version: 1,
              mode: 'value',
              field: 'population',
              encoding: 'json',
            },
          })
        ),
      /Value presentation must select/
    );
  }
  requests.length = 0;
  truncate = true;
  process.env.TRACE_ARCHIVE_ENABLED = '1';
  process.env.TRACE_ARCHIVE_BACKEND = 'local';
  process.env.TRACE_ARCHIVE_LOCAL_DIR = archiveDir;
  // A hermetic process-only test key when no managed key was supplied.
  process.env.TRACE_ARCHIVE_ENCRYPTION_KEY_B64 ||= Buffer.alloc(32, 7).toString('base64');
  const archived = await generateResponseSchema('find the population of Tokyo', {
    archive: { archive_scope: { userId: 'schema-retry-control' } },
  });
  assert.equal(archived.schema.fields[0].name, 'tokyo_population');
  assert.deepEqual(
    requests.map((r) => r.max_completion_tokens),
    [2000, 2000, 4000]
  );
  for (const request of requests.slice(1)) {
    assert.deepEqual(request.messages[2], {
      role: 'assistant',
      content: captured.content,
    });
    assert.match(request.messages[3].content, /Value presentation must select/);
  }
  const callerRoot = 'user-schema-retry-control';
  await drainLlmCaptures([callerRoot]);
  const objects = await listArchivedObjects(callerRoot, { throwOnError: true });
  const starts = objects.filter((o) => o.path.startsWith('llm/'));
  const finals = objects.filter((o) => o.path.startsWith('llm-updates/'));
  assert.equal(starts.length, 3, 'each generation call archives a start under caller root');
  assert.equal(finals.length, 3, 'each generation call archives a final under caller root');
  assert.deepEqual(readdirSync(join(archiveDir, 'trace-archive')), [callerRoot]);
  type ArchiveRecord = {
    root_agent_id: string;
    record: string;
    message_count?: number;
    messages?: Array<{ role: string; content: string }>;
    output?: { content?: string };
  };
  const records: ArchiveRecord[] = [];
  for (const object of [...starts, ...finals]) {
    const stored = await readArchivedArtifact({
      rootAgentId: callerRoot,
      objectPath: object.path,
    });
    assert.ok(stored, 'archived record is readable');
    const record = JSON.parse(decryptAndValidateArtifact(stored).toString('utf8')) as ArchiveRecord;
    assert.equal(record.root_agent_id, callerRoot);
    records.push(record);
  }
  const retries = records.filter((r) => r.record === 'start' && r.message_count === 4);
  assert.equal(retries.length, 2);
  for (const retry of retries) {
    assert.deepEqual(retry.messages?.[2], {
      role: 'assistant',
      content: captured.content,
    });
    assert.match(retry.messages?.[3].content ?? '', /Value presentation must select/);
  }
  assert.ok(
    records.some((r) => r.record === 'final' && r.output?.content === captured.content),
    'rejected bytes survive the final archive without answer rewriting'
  );
  process.env.TRACE_ARCHIVE_ENABLED = '0';
  truncate = false;
  // Isolate the two provider legs; disable_waterfall uses the normal Rose client.
  for (let slot = 1; slot <= 9; slot++) {
    process.env['AZURE_FOUNDRY_ENDPOINT' + (slot === 1 ? '' : '_' + slot)] = '';
  }
  process.env.AZURE_FOUNDRY_ENDPOINT = 'https://schema-retry.test';
  process.env.AZURE_FOUNDRY_API_KEY = 'test-foundry-key';
  process.env.AZURE_FOUNDRY_DEPLOYMENTS = 'gpt-6-luna';
  process.env.COMPUTE_TOKEN_AUTHORITY_URL = 'https://authority.schema-retry.test';
  process.env.COMPUTE_TOKEN_AUTHORITY_API_KEY = 'test-authority-key';
  for (const status of [400, 401]) {
    requests.length = 0;
    fatalStatus = status;
    await assert.rejects(
      generateResponseSchema('fatal request control', {
        directAuth: { type: 'claude', accessToken: 'test-credential' },
      })
    );
    assert.equal(requests.length, 2, 'one outer attempt walks the existing Cerebras/Foundry legs');
  }
  // Ordinary valid report/value inputs retain their exact field names and policy.
  for (const presentation of [
    undefined,
    { version: 1, mode: 'report' },
    { version: 1, mode: 'value', field: 'count', encoding: 'text' },
  ]) {
    const parsed = parseGeneratedResponseSchemaJson(
      JSON.stringify({
        reasoning: 'one count',
        fields: [{ name: 'count', type: 'int', required: true }],
        presentation,
      })
    );
    assert.equal(parsed.fields[0].name, 'count');
    assert.deepEqual(parsed.presentation, presentation);
  }
  console.log('PASS response-schema-retry');
}
main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    globalThis.fetch = originalFetch;
    rmSync(archiveDir, { recursive: true, force: true });
  });
