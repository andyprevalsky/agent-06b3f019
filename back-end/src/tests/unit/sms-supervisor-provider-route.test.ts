import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SUPERVISOR_LLM_SOURCE = readFileSync(
  join(__dirname, '../../providers/smsSupervisor/supervisorLlm.ts'),
  'utf8'
);

function test(name: string, run: () => void): void {
  run();
  process.stdout.write(`PASS sms-supervisor-provider-route: ${name}\n`);
}

test('defaults to rose-fast pool path — no exclusive cerebras / gpt-oss override', () => {
  // 2026-09-29: SMS forced provider_route 'direct-cerebras', which hardcodes
  // gpt-oss-120b and bypasses rose-fast's pool.cerebrasModel (qwen-3.8-27b).
  // Default must omit provider_route so createStreamingCompletion uses the
  // rose-1-flash pool path. Benchmark env overrides remain for eval isolation.
  assert.ok(SUPERVISOR_LLM_SOURCE.includes("SMS_SUPERVISOR_MODEL = 'rose-labs/rose-1-flash'"));
  assert.ok(SUPERVISOR_LLM_SOURCE.includes('BENCHMARK_SMS_SUPERVISOR_MODEL'));
  assert.ok(SUPERVISOR_LLM_SOURCE.includes("providerRoute ?? 'pool-default'"));

  // Default assignment must NOT pin direct-cerebras. The only remaining
  // 'direct-cerebras' mention is inside the benchmark route-override allowlist.
  const allowlistHits = (
    SUPERVISOR_LLM_SOURCE.match(/routeOverride === 'direct-cerebras'/g) ?? []
  ).length;
  assert.equal(allowlistHits, 1, 'direct-cerebras may appear only as a benchmark allowlist check');
  const allDirectHits = (SUPERVISOR_LLM_SOURCE.match(/direct-cerebras/g) ?? []).length;
  assert.equal(
    allDirectHits,
    1,
    `expected exactly one 'direct-cerebras' mention (benchmark allowlist); found ${allDirectHits}`
  );

  // Compute tokens must stay OFF the default (undefined-route) path.
  for (const token of ['claude_token', 'gpt_token']) {
    const gated = SUPERVISOR_LLM_SOURCE.includes(
      `providerRoute !== undefined && ${token === 'claude_token' ? 'claudeToken' : 'gptToken'}`
    );
    assert.ok(
      gated,
      `${token} must be gated behind providerRoute !== undefined; ungated send puts SMS on a user compute token instead of rose-fast`
    );
  }
});

test('keeps the full grep surface — the union limit is not a reason to cut tools', () => {
  // Guard against re-trimming. These were briefly deleted to squeeze under
  // Anthropic's union cap; that cap does not apply on the Cerebras route, and
  // narrowing what the supervisor can search is a real capability loss.
  const schema = readFileSync(join(__dirname, '../../providers/smsSupervisor/schema.ts'), 'utf8');
  for (const flag of ['-B', '-A', '-C', '-n', '-i']) {
    assert.ok(schema.includes(`'${flag}'`));
  }
  for (const field of ['multiline', 'offset', 'head_limit', 'context']) {
    assert.ok(schema.includes(`${field}: z`));
  }
  for (const filter of [
    'account',
    'status',
    'include_pending_in_totals',
    'document_source',
    'path',
    'tag',
  ]) {
    assert.ok(schema.includes(`${filter}:`));
  }
});

test('marks assistant tool_calls as type=function for OpenAI-compatible providers', () => {
  // Cerebras 400s without it ("messages.N.assistant.tool_calls.0.type: Field
  // required", code=wrong_api_format). That is an invalid_request, so the
  // route sends it straight to the generic waterfall rather than the
  // same-model OpenRouter hop — every SMS turn silently left GLM-4.7.
  const source = readFileSync(
    join(__dirname, '../../providers/smsSupervisor/environmentMessages.ts'),
    'utf8'
  );
  // Count, don't spot-check. A `toContain` passed with only ONE of the two
  // tool_call sites patched, so the run still 400'd and still silently left
  // GLM-4.7 — the assertion was satisfied while the bug was live.
  const toolCallSites = (source.match(/tool_calls: \[/g) ?? []).length;
  const typedSites = (source.match(/type: 'function'/g) ?? []).length;
  assert.ok(toolCallSites > 0);
  assert.equal(typedSites, toolCallSites);
});
