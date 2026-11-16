#!/usr/bin/env tsx
/** Captured schema-author rejection must change the next provider request. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
const originalFetch = globalThis.fetch;
const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
process.env.CEREBRAS_API_KEY = 'test-schema-retry';
process.env.TRACE_ARCHIVE_ENABLED = '0';

globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body)) as (typeof requests)[number];
  requests.push(body);
  const feedback = body.messages.at(-1)?.content;
  const content =
    recover && feedback?.startsWith('Response schema failed schema:')
      ? correction.content
      : captured.content;
  return new Response(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`,
    { headers: { 'Content-Type': 'text/event-stream' } }
  );
};

async function main(): Promise<void> {
  // Equal accepted values expressed using the common provider subset, not const-only nodes.
  const variants = RESPONSE_SCHEMA_JSON_SCHEMA.properties.presentation.anyOf;
  assert.equal(JSON.stringify(variants).includes('"const"'), false);
  assert.deepEqual(variants[1].properties?.version, { type: 'integer', enum: [1] });
  assert.deepEqual(variants[2].properties?.encoding, { type: 'string', enum: ['text', 'json'] });
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
    assert.deepEqual(request.messages[2], { role: 'assistant', content: captured.content });
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
  assert.deepEqual(requests[1].messages[2], { role: 'assistant', content: captured.content });
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
            presentation: { version: 1, mode: 'value', field: 'population', encoding: 'text' },
          })
        ),
      /Value presentation must select|at least one required/
    );
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
  });
