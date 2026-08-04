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

test('routes through Cerebras with failover, never straight at Anthropic', () => {
  // 2026-07-28: the supervisor sent `claude_token`, routing every turn direct
  // to Anthropic. That made this surface depend on three independent things —
  // the user's OAuth token, an API key with credit, and a tool schema under
  // Anthropic's 16-union-parameter ceiling. All three failed at once, every
  // call 400'd, and the run degraded silently to a waterfall model.
  //
  // The fix is the route, NOT a smaller tool surface. `direct-cerebras`
  // carries its own cascade (quota/rate -> same model via OpenRouter with the
  // provider unpinned; stalls/5xx/empty -> generic waterfall), so one provider
  // having a bad minute cannot take SMS down.
  // The default path must still be Cerebras. The benchmark override exists
  // only to A/B a different model against the same task; it is env-gated and
  // unset in prod.
  assert.ok(SUPERVISOR_LLM_SOURCE.includes("providerRoute: 'direct-cerebras'"));
  assert.ok(SUPERVISOR_LLM_SOURCE.includes('BENCHMARK_SMS_SUPERVISOR_MODEL'));
  assert.ok(!SUPERVISOR_LLM_SOURCE.includes('claude_token'));
  assert.ok(!SUPERVISOR_LLM_SOURCE.includes('gpt_token'));
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
