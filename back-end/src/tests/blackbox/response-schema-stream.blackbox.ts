#!/usr/bin/env tsx
/**
 * Schema-gen stream finalize must not call finalText().
 *
 * An empty / reasoning-only stream used to throw
 * StructuredOutputCardinalityError before Zod ran. Health check is
 * currentText() + ResponseSchemaSchema.safeParse. Outer generateResponseSchema
 * already retries that class.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  StructuredOutputAccumulator,
  StructuredOutputCardinalityError,
} from '../../providers/rose/structuredOutput';
import { parseGeneratedResponseSchemaJson } from '../../providers/setResponseSchema';

const here = dirname(fileURLToPath(import.meta.url));

function testEmptyStreamDoesNotThrowCardinality(): void {
  const empty = new StructuredOutputAccumulator();
  assert.throws(() => empty.finalText(), StructuredOutputCardinalityError);
  assert.equal(empty.currentText(), '');
  assert.throws(
    () => parseGeneratedResponseSchemaJson(empty.currentText()),
    /LLM returned no content/
  );
}

function testReasoningOnlyDoesNotThrowCardinality(): void {
  const acc = new StructuredOutputAccumulator();
  acc.addText('thinking about fields', { item_id: 'reasoning:0', phase: 'reasoning' });
  assert.throws(() => acc.finalText(), StructuredOutputCardinalityError);
  assert.throws(
    () => parseGeneratedResponseSchemaJson(acc.currentText()),
    /LLM returned no content/
  );
}

function testValidSchemaPassesZod(): void {
  const parsed = parseGeneratedResponseSchemaJson(
    JSON.stringify({
      reasoning: 'need the population',
      fields: [{ name: 'population', type: 'int' }],
    })
  );
  assert.equal(parsed.fields[0]?.name, 'population');
}

function testEmptyFieldsFailZod(): void {
  assert.throws(
    () => parseGeneratedResponseSchemaJson(JSON.stringify({ reasoning: 'none', fields: [] })),
    /failed schema/i
  );
}

function testLiveCallersDoNotUseFinalText(): void {
  const schemaGen = readFileSync(join(here, '../../providers/setResponseSchema.ts'), 'utf8');
  assert.match(schemaGen, /ResponseSchemaSchema\.safeParse/);
  const files = [
    '../../providers/setResponseSchema.ts',
    '../../providers/smsSupervisor/supervisorLlm.ts',
    '../../providers/credentialPropagationClassifier.ts',
    '../../domains/credential-propagation/classifier.ts',
  ];
  for (const relative of files) {
    const source = readFileSync(join(here, relative), 'utf8');
    assert.equal(
      source.includes('.finalText()'),
      false,
      `${relative} must not call finalText() on a degrade path`
    );
  }
}

function main(): void {
  testEmptyStreamDoesNotThrowCardinality();
  testReasoningOnlyDoesNotThrowCardinality();
  testValidSchemaPassesZod();
  testEmptyFieldsFailZod();
  testLiveCallersDoNotUseFinalText();
  process.stdout.write('PASS response-schema-stream (5 cases)\n');
}

try {
  main();
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
}
