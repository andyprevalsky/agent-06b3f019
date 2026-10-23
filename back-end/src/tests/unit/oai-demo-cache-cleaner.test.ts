#!/usr/bin/env tsx

import assert from 'node:assert';
import {
  containsBrowserToolCall,
  containsNestedAgentToolCall,
  rewriteOaiDemoCacheValue,
} from '../../domains/demo-cache/oaiDemoCacheCleaner';

let passed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ✅ ${name}\n`);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    process.stdout.write(`  ❌ ${name}\n`);
  }
}

test('deletes a cached browser spawn without introducing replacement work', () => {
  const original = {
    content: 'I will use a browser agent to navigate the public channel.',
    reasoning: 'The browser will inspect the latest public videos.',
    tool_calls: [
      {
        id: 'call-browser',
        name: 'spawn_agent',
        arguments: JSON.stringify({
          type: 'browser',
          goal: 'Inspect the creator channel.',
          start_url: 'https://youtube.com/example',
          output_schema: { fields: [] },
        }),
      },
    ],
  };

  const result = rewriteOaiDemoCacheValue(original);
  assert.strictEqual(result.changed, true);
  assert.strictEqual(result.deleteEntry, true);
  assert.strictEqual(result.browserCallsRemoved, 1);
  assert.strictEqual(result.exploreCallsAdded, 0);
  assert.strictEqual(containsBrowserToolCall(result.value), false);
  assert.strictEqual(original.tool_calls[0].arguments.includes('"type":"browser"'), true);

  const rewritten = result.value as typeof original;
  assert.deepStrictEqual(rewritten.tool_calls, []);
  assert.doesNotMatch(String(rewritten.content), /browser/i);
  assert.doesNotMatch(String(rewritten.reasoning), /browser/i);
});

test('drops a browser duplicate when the same response already spawns explore', () => {
  const result = rewriteOaiDemoCacheValue({
    tool_calls: [
      {
        id: 'call-explore',
        name: 'spawn_agent',
        arguments: { type: 'explore', goal: 'Research the creator.' },
      },
      {
        id: 'call-browser',
        name: 'spawn_browser_agent',
        arguments: { goal: 'Research the creator.', start_url: 'https://example.com' },
      },
    ],
  });

  assert.strictEqual(result.changed, true);
  assert.strictEqual(result.browserCallsRemoved, 1);
  assert.strictEqual(result.exploreCallsAdded, 0);
  const calls = (result.value as { tool_calls: unknown[] }).tool_calls;
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(containsBrowserToolCall(result.value), false);
});

test('removes OpenAI function-shaped browser calls', () => {
  const result = rewriteOaiDemoCacheValue({
    tool_calls: [
      {
        id: 'call-browser',
        type: 'function',
        function: {
          name: 'spawn_agent',
          arguments: { type: 'browser', goal: 'Open public results.' },
        },
      },
    ],
  });
  const calls = (result.value as { tool_calls: unknown[] }).tool_calls;
  assert.deepStrictEqual(calls, []);
  assert.strictEqual(containsBrowserToolCall(result.value), false);
});

test('deletes cached nested general-purpose and code-agent spawns', () => {
  const original = {
    content: 'I will delegate the remaining synthesis.',
    tool_calls: [
      {
        id: 'call-general-purpose',
        name: 'spawn_agent',
        arguments: JSON.stringify({
          type: 'general_purpose',
          goal: 'Synthesize the creator research.',
        }),
      },
      {
        id: 'call-code',
        type: 'function',
        function: {
          name: 'spawn_agent',
          arguments: { type: 'code', goal: 'Format the report files.' },
        },
      },
      {
        id: 'call-for-each',
        name: 'spawn_agent',
        arguments: { type: 'for_each', goal: 'Repeat nested work.' },
      },
      {
        id: 'call-explore',
        name: 'spawn_agent',
        arguments: { type: 'explore', goal: 'Research the creator.' },
      },
    ],
  };

  assert.strictEqual(containsNestedAgentToolCall(original), true);
  const result = rewriteOaiDemoCacheValue(original);
  assert.strictEqual(result.changed, true);
  assert.strictEqual(result.deleteEntry, true);
  assert.strictEqual(result.nestedAgentCallsRemoved, 3);
  assert.strictEqual(containsNestedAgentToolCall(result.value), false);
  assert.deepStrictEqual(
    (result.value as typeof original).tool_calls.map((call) => call.id),
    ['call-explore']
  );
});

test('recognizes legacy named general-purpose and code-agent tool calls', () => {
  for (const name of [
    'spawn_general_purpose_agent',
    'spawn_general_purpose_agent_for_each',
    'spawn_code_agent',
    'spawn_claude_code_agent',
  ]) {
    const value = { tool_calls: [{ name, arguments: { goal: 'Nested work.' } }] };
    assert.strictEqual(containsNestedAgentToolCall(value), true, name);
    const result = rewriteOaiDemoCacheValue(value);
    assert.strictEqual(result.deleteEntry, true, name);
    assert.strictEqual(result.nestedAgentCallsRemoved, 1, name);
  }
});

test('leaves browser-free cache values byte-for-byte equivalent', () => {
  const original = {
    content: 'Research is complete.',
    reasoning: 'Summarize the evidence.',
    tool_calls: [{ name: 'attempt_completion', arguments: '{"result":"done"}' }],
    usage: { cache_read_input_tokens: 100 },
  };
  const result = rewriteOaiDemoCacheValue(original);
  assert.strictEqual(result.changed, false);
  assert.strictEqual(result.deleteEntry, false);
  assert.deepStrictEqual(result.value, original);
});

if (failures.length > 0) {
  process.stderr.write(`\n${failures.length} failure(s):\n`);
  failures.forEach((failure) => process.stderr.write(`  - ${failure}\n`));
  process.exit(1);
}
process.stdout.write(`\n${passed} OAI demo cache cleaner tests passed\n`);
