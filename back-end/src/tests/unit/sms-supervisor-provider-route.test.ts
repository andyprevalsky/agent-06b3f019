import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { GREP_TOOL_DEFINITION } from '../../providers/grepTool';
import { SmsSupervisorToolCallSchema } from '../../providers/smsSupervisor/schema';
import { TOOL_SCHEMAS } from '../../providers/smsSupervisor/supervisorTools.schemas';
import {
  buildEnvironmentToolMessages,
  buildNativeToolFeedbackMessages,
  buildToolFeedbackMessages,
} from '../../providers/smsSupervisor/environmentMessages';

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
  const allowlistHits = (SUPERVISOR_LLM_SOURCE.match(/routeOverride === 'direct-cerebras'/g) ?? [])
    .length;
  assert.equal(allowlistHits, 1, 'direct-cerebras may appear only as a benchmark allowlist check');
  const allDirectHits = (SUPERVISOR_LLM_SOURCE.match(/direct-cerebras/g) ?? []).length;
  assert.equal(
    allDirectHits,
    1,
    `expected exactly one 'direct-cerebras' mention (benchmark allowlist); found ${allDirectHits}`
  );

  // Compute tokens must stay OFF the default (no-override) path: only a forced
  // route or an explicit benchmark pool lease may send them.
  assert.ok(
    SUPERVISOR_LLM_SOURCE.includes(
      'const sendComputeTokens = providerRoute !== undefined || benchmarkPoolLease;'
    )
  );
  for (const token of ['claudeToken', 'gptToken']) {
    assert.ok(
      SUPERVISOR_LLM_SOURCE.includes(`sendComputeTokens && ${token}`),
      `${token} must be gated behind sendComputeTokens; ungated send puts SMS on a user compute token instead of rose-fast`
    );
  }
});

test('pool-default benchmark override serves a pool exactly as production would', () => {
  // A/B'ing another pool as the supervisor model must run that pool's normal
  // path (no provider_route) and stay tokenless, like a real SMS_SUPERVISOR_MODEL
  // change; forcing a route would measure a provider leg production never uses.
  assert.ok(SUPERVISOR_LLM_SOURCE.includes("routeOverride !== 'pool-default'"));
  // A pool lease needs the override model, pool-default, AND a pinned token type.
  assert.ok(SUPERVISOR_LLM_SOURCE.includes("routeOverride === 'pool-default' &&"));
  assert.ok(SUPERVISOR_LLM_SOURCE.includes('benchmarkSupervisorTokenType() !== undefined'));
});

test('dumps every supervisor call for replay (dev only)', () => {
  // Without a dump_context the supervisor's raw request/response was never
  // captured, so an empty-tool-call round could not be inspected or replayed.
  assert.ok(SUPERVISOR_LLM_SOURCE.includes("dump_context: { call_site: 'sms_supervisor'"));
});

test('keeps the full grep surface — the union limit is not a reason to cut tools', () => {
  // Guard against re-trimming. These were briefly deleted to squeeze under
  // Anthropic's union cap; that cap does not apply on the Cerebras route, and
  // narrowing what the supervisor can search is a real capability loss. The
  // surface is the one shared grep definition (providers/grepTool), which the
  // supervisor sends as is, so it is asserted there and on the supervisor's
  // own tool list and response union.
  const properties = GREP_TOOL_DEFINITION.parameters.properties as Record<string, unknown>;
  for (const flag of ['-B', '-A', '-C', '-n', '-i']) {
    assert.ok(flag in properties, `grep definition keeps ${flag}`);
  }
  for (const field of ['multiline', 'offset', 'head_limit', 'context']) {
    assert.ok(field in properties, `grep definition keeps ${field}`);
  }
  const filters = properties.filters as { anyOf: Array<{ properties: Record<string, unknown> }> };
  const filterKeys = Object.keys(filters.anyOf[0].properties);
  for (const filter of [
    'account',
    'status',
    'include_pending_in_totals',
    'document_source',
    'path',
    'tag',
  ]) {
    assert.ok(filterKeys.includes(filter), `grep definition keeps filters.${filter}`);
  }
  assert.ok(
    TOOL_SCHEMAS.includes(GREP_TOOL_DEFINITION),
    'the supervisor offers the shared grep definition itself'
  );
  const call = {
    tool: 'grep',
    arguments: {
      pattern: 'x',
      '-B': 1,
      '-A': 1,
      '-C': 1,
      '-n': true,
      '-i': true,
      multiline: false,
      offset: 0,
      head_limit: 5,
      context: 1,
      filters: { account: 'a', status: 'posted', include_pending_in_totals: true, tag: 't' },
    },
  };
  assert.ok(SmsSupervisorToolCallSchema.safeParse(call).success, 'the response union accepts it');
});

test('marks assistant tool_calls as type=function for OpenAI-compatible providers', () => {
  // Cerebras 400s without it ("messages.N.assistant.tool_calls.0.type: Field
  // required", code=wrong_api_format). That is an invalid_request, so the
  // route sends it straight to the generic waterfall rather than the
  // same-model OpenRouter hop — every SMS turn silently left GLM-4.7.
  // Check every builder's actual output: a source count passed with only one
  // of two sites patched while the bug was live.
  const grep = { tool: 'grep', arguments: { pattern: 'passport' }, id: 'call_a' };
  const send = { tool: 'send_user_message', arguments: { message: 'hi' } };
  const built = [
    ...buildEnvironmentToolMessages('env', 1),
    ...buildToolFeedbackMessages({
      round: 0,
      assistantPayload: '{}',
      toolResultSummary: '',
      guidance: 'g',
    }),
    ...buildNativeToolFeedbackMessages({
      round: 1,
      toolCalls: [grep, send],
      resultsByCall: new Map([[grep, [{ tool: 'grep', success: true, result: 'hit' }]]]),
      roundResults: [],
      guidance: 'g',
    }),
  ];
  const toolCalls = built.flatMap((message) => message.tool_calls ?? []);
  assert.equal(toolCalls.length, 4);
  for (const toolCall of toolCalls) assert.equal(toolCall.type, 'function');
});

test('every document_source the grep description offers is accepted by the supervisor schema', () => {
  // The description once named Granola values the enums still rejected, so
  // the supervisor was told to send arguments its own schema refused. The
  // values are now read from the shared definition's description and parsed
  // by the supervisor's real response union, flat and in a documents block.
  const filters = (
    GREP_TOOL_DEFINITION.parameters.properties as Record<string, { description?: string }>
  ).filters;
  const description = filters.description ?? '';
  const offered = [
    ...new Set(
      description.match(
        /\b(?:chatgpt|claude|apple_notes|obsidian|granola(?:_note|_summary|_transcript)?)\b/g
      )
    ),
  ].sort();
  assert.deepEqual(
    offered,
    [
      'apple_notes',
      'chatgpt',
      'claude',
      'granola',
      'granola_note',
      'granola_summary',
      'granola_transcript',
      'obsidian',
    ],
    'the description offers every document layer, Granola included'
  );
  for (const value of offered) {
    const flat = { tool: 'grep', arguments: { pattern: 'x', filters: { document_source: value } } };
    const nested = {
      tool: 'grep',
      arguments: { pattern: 'x', filters: { documents: { document_source: value } } },
    };
    assert.ok(SmsSupervisorToolCallSchema.safeParse(flat).success, `flat ${value} accepted`);
    assert.ok(SmsSupervisorToolCallSchema.safeParse(nested).success, `nested ${value} accepted`);
  }
});
