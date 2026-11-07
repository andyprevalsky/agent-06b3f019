#!/usr/bin/env tsx

import assert from 'node:assert';
import 'dotenv/config';

import { GREP_TOOL_STRICT_PARAMETERS } from '../../providers/grepTool';
import {
  RouterDecisionSchema,
  isValidRouterCacheJson,
  parsePartialRouterDecisionJson,
  parseRouterDecisionJson,
  requireRouterDecision,
} from '../../providers/chat/routerDecision';
import { ChatLlmTransientMissError } from '../../providers/chat/chatStructuredRetry';

/** Compare decisions as they serialize: omitted grep arguments are absent, not undefined. */
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

/** A strict-provider grep argument object: every key present, unused ones null. */
function strictGrepArgs(values: Record<string, unknown>): Record<string, unknown> {
  const properties = (GREP_TOOL_STRICT_PARAMETERS as { properties: Record<string, unknown> })
    .properties;
  return Object.fromEntries(Object.keys(properties).map((key) => [key, values[key] ?? null]));
}

/**
 * The chat grep action carries one call of the shared grep tool definition.
 * A strict provider fills every key (null when unused); the decision keeps
 * only real arguments, other actions ignore `grep: null`, partial streams act
 * only on a closed grep object, and a spent search budget rejects grep.
 */
function grepAction(): void {
  const strict = GREP_TOOL_STRICT_PARAMETERS as {
    properties: Record<string, { anyOf?: Array<{ properties?: Record<string, unknown> }> }>;
  };
  const filterKeys = Object.keys(strict.properties.filters.anyOf?.[0].properties ?? {});
  assert(filterKeys.includes('since') && filterKeys.includes('calendar'), 'typed filters');
  const provider = {
    reasoning: 'their dentist appointment is in their calendar',
    action: 'grep',
    queries: [],
    goal: '',
    mode: 'plan',
    grep: strictGrepArgs({
      pattern: 'dentist',
      sources: ['calendar'],
      filters: Object.fromEntries(
        filterKeys.map((key) => [key, key === 'since' ? '2026-11-01' : null])
      ),
    }),
  };
  const json = JSON.stringify(provider);
  assert.equal(isValidRouterCacheJson(json), true, 'a strict grep decision is a valid cache row');
  const decision = parseRouterDecisionJson(json);
  assert.deepEqual(plain(decision), {
    action: 'grep',
    reasoning: provider.reasoning,
    grep: { pattern: 'dentist', sources: ['calendar'], filters: { since: '2026-11-01' } },
  });
  assert.equal(RouterDecisionSchema.safeParse(decision).success, true);

  assert.deepEqual(
    plain(parseRouterDecisionJson(JSON.stringify({ action: 'grep', reasoning: 'r', grep: {} }))),
    { action: 'grep', reasoning: 'r', grep: {} },
    'grep with no arguments searches the local defaults'
  );
  for (const rejected of [
    { action: 'grep', reasoning: 'r' },
    { action: 'grep', reasoning: 'r', grep: null },
    { action: 'grep', reasoning: 'r', grep: { pattern: 'x', not_a_grep_key: 1 } },
    { action: 'grep', reasoning: 'r', grep: { sources: ['not_a_source'] } },
  ]) {
    const rejectedJson = JSON.stringify(rejected);
    assert.throws(() => parseRouterDecisionJson(rejectedJson), /failed schema/i, rejectedJson);
    assert.equal(isValidRouterCacheJson(rejectedJson), false, `cache must reject: ${rejectedJson}`);
  }
  assert.deepEqual(
    parseRouterDecisionJson(
      JSON.stringify({
        reasoning: 'answer directly',
        action: 'direct_answer',
        queries: [],
        goal: '',
        mode: 'plan',
        grep: null,
      })
    ),
    { action: 'direct_answer', reasoning: 'answer directly' },
    'non-grep actions ignore the grep: null sentinel'
  );

  // Partial streams: grep comes last, so a cut-off grep object is never run…
  const cut = json.slice(0, json.indexOf('"since"'));
  assert.equal(
    parsePartialRouterDecisionJson(cut),
    null,
    'a cut-off grep object is not actionable'
  );
  // …a closed one is, even before the outer object closes…
  assert.deepEqual(plain(parsePartialRouterDecisionJson(json.slice(0, -1))), plain(decision));
  // …and the string fields before it still recover for other actions.
  const escalation = JSON.stringify({
    reasoning: 'needs an agent',
    action: 'start_superintelligence',
    queries: [],
    goal: 'book the dentist',
    mode: 'execute',
    grep: null,
  });
  assert.deepEqual(parsePartialRouterDecisionJson(escalation.slice(0, -12)), {
    action: 'start_superintelligence',
    reasoning: 'needs an agent',
    goal: 'book the dentist',
    mode: 'execute',
  });
  assert.equal(
    parsePartialRouterDecisionJson(
      '{"reasoning":"r","action":"grep","queries":[],"goal":"","mode":"plan","grep":{"pattern":"a}b{"'
    ),
    null,
    'braces inside a string never close the grep object'
  );

  // A spent search budget offers no search action; a provider that still picks grep missed.
  assert.throws(
    () =>
      requireRouterDecision({
        finalized: { decision, fullJson: json },
        deadlineExpired: false,
        stage: 'search_budget_spent',
      }),
    (error: unknown) =>
      error instanceof ChatLlmTransientMissError &&
      /grep after the search budget/.test(error.message)
  );
  assert.equal(
    requireRouterDecision({
      finalized: { decision, fullJson: json },
      deadlineExpired: false,
      stage: 'after_search',
    }),
    decision,
    'grep is a legal route while search rounds remain'
  );
}

function main(): void {
  const direct = JSON.stringify({ action: 'direct_answer', reasoning: 'answer directly' });
  assert.equal(isValidRouterCacheJson(direct), true);
  assert.deepEqual(parseRouterDecisionJson(direct), {
    action: 'direct_answer',
    reasoning: 'answer directly',
  });

  assert.deepEqual(
    parseRouterDecisionJson(
      JSON.stringify({
        action: 'start_superintelligence',
        reasoning: 'delegate',
        goal: 'finish the task',
      })
    ),
    {
      action: 'start_superintelligence',
      reasoning: 'delegate',
      goal: 'finish the task',
      mode: 'plan',
    },
    'legacy cached agent decisions default to plan mode'
  );

  assert.equal(
    isValidRouterCacheJson('{\n  "'),
    false,
    'a truncated router response must never become an authoritative cache hit'
  );
  assert.equal(
    isValidRouterCacheJson(JSON.stringify({ action: 'web_search', reasoning: 'search' })),
    false,
    'action-specific required fields are validated before accepting a cache hit'
  );
  assert.throws(
    () => parseRouterDecisionJson(JSON.stringify({ action: 'direct_answer' })),
    /failed schema/i
  );
  assert.deepEqual(
    parseRouterDecisionJson(
      JSON.stringify({
        action: 'direct_answer',
        reasoning: 'answer directly',
        query: '',
        goal: '',
        mode: 'plan',
      })
    ),
    { action: 'direct_answer', reasoning: 'answer directly' },
    'provider-flat unused fields must strip through the Zod schema'
  );
  assert.throws(
    () =>
      parseRouterDecisionJson(
        JSON.stringify({ action: 'web_search', reasoning: 'search', query: '' })
      ),
    /failed schema/i,
    'empty web_search query is not a healthy decision'
  );
  assert.throws(
    () =>
      parseRouterDecisionJson(
        JSON.stringify({ action: 'web_search', reasoning: 'search', queries: [] })
      ),
    /failed schema/i,
    'web_search without any query is not a healthy decision'
  );
  assert.deepEqual(
    parseRouterDecisionJson(
      JSON.stringify({ action: 'web_search', reasoning: 'search', query: 'weather' })
    ),
    { action: 'web_search', reasoning: 'search', queries: ['weather'] },
    'legacy cached single-query decisions replay as one query'
  );

  // INVARIANT: the cache validator, the live parser, and `RouterDecisionSchema` must never disagree.
  // `RouterDecisionSchema` requires `mode` while the parser tolerates a legacy cache entry that
  // omits it, so the parser's compatibility default is the only thing keeping the two in step. If a
  // future edit drops that default (or adds a field the schema does not model), a cached decision
  // could pass `isValidRouterCacheJson` and then fail the type it is asserted to have.
  const decisions = [
    { action: 'direct_answer', reasoning: 'answer directly' },
    { action: 'web_search', reasoning: 'search', query: 'weather' },
    { action: 'web_search', reasoning: 'search', queries: ['weather paris', 'weather tokyo'] },
    { action: 'start_superintelligence', reasoning: 'delegate', goal: 'finish' },
    { action: 'start_superintelligence', reasoning: 'delegate', goal: 'finish', mode: 'execute' },
  ];
  for (const decision of decisions) {
    const json = JSON.stringify(decision);
    assert.equal(
      isValidRouterCacheJson(json),
      true,
      `cache validator must accept a decision the live path parses: ${json}`
    );
    const parsedDecision = parseRouterDecisionJson(json);
    assert.equal(
      RouterDecisionSchema.safeParse(parsedDecision).success,
      true,
      `RouterDecisionSchema must accept the parser's own output: ${JSON.stringify(parsedDecision)}`
    );
  }

  // ...and a value the parser rejects must never be accepted as an authoritative cache hit.
  for (const rejected of [
    { action: 'start_superintelligence', reasoning: 'delegate', goal: 'g', mode: 'turbo' },
    { action: 'unknown_action', reasoning: 'r' },
    { action: 'start_superintelligence', reasoning: 'r' },
  ]) {
    const json = JSON.stringify(rejected);
    assert.throws(() => parseRouterDecisionJson(json));
    assert.equal(isValidRouterCacheJson(json), false, `cache must reject: ${json}`);
  }
}

main();
grepAction();
