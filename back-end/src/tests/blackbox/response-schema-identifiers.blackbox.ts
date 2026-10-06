#!/usr/bin/env tsx
/**
 * Identifiers stay strings in generated response schemas.
 *
 * A "member number" like RS-92884370 typed as `int` reaches the user as
 * 92884370: the Task Complete card drops the prefix, and the hosted-auth
 * benches that check the deliverable for the member number fail. The schema
 * generator's prompt names identifiers as `str`; this runs the real generator
 * on identifier-shaped goals and requires the identifier field to be a string.
 */

import assert from 'node:assert/strict';

import { generateResponseSchema } from '../../providers/setResponseSchema';

const CASES: { goal: string; field: RegExp }[] = [
  {
    goal: 'Tell me my member number for https://shop.example.test/api/rose-shop/fd8d8c49c667/?authRealm=rose-shop-fd8d8c49c667',
    field: /member/i,
  },
  {
    goal: 'Buy me a Canvas Tote from https://shop.example.test/ and tell me the order number',
    field: /order/i,
  },
  {
    goal: 'Find the tracking number for my latest Nordstrom order in my email',
    field: /tracking/i,
  },
];

// The generator is an LLM call, and the `int` typing showed up in roughly one
// run in several, so each goal is sampled more than once.
const SAMPLES = Number(process.env.RESPONSE_SCHEMA_IDENTIFIER_SAMPLES) || 5;

async function main(): Promise<void> {
  const failures: string[] = [];
  for (const testCase of CASES) {
    for (let sample = 1; sample <= SAMPLES; sample++) {
      const { schema } = await generateResponseSchema(testCase.goal);
      const field = schema.fields.find((candidate) => testCase.field.test(candidate.name));
      assert.ok(
        field,
        `no field matching ${testCase.field} for "${testCase.goal}": ${JSON.stringify(schema.fields)}`
      );
      if (field.type !== 'str') {
        failures.push(`sample ${sample}: ${field.name} is ${field.type} for "${testCase.goal}"`);
      }
    }
  }
  assert.deepEqual(failures, [], `identifier fields must be str:\n${failures.join('\n')}`);
  process.stdout.write(
    `PASS response-schema-identifiers (${CASES.length} goals × ${SAMPLES} samples, all str)\n`
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
