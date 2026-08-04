#!/usr/bin/env tsx

import assert from 'node:assert';
import 'dotenv/config';

import {
  RouterDecisionSchema,
  isValidRouterCacheJson,
  parseRouterDecisionJson,
} from '../../providers/chat/routerDecision';

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
    /requires reasoning/
  );

  // INVARIANT: the cache validator, the live parser, and `RouterDecisionSchema` must never disagree.
  // `RouterDecisionSchema` requires `mode` while the parser tolerates a legacy cache entry that
  // omits it, so the parser's compatibility default is the only thing keeping the two in step. If a
  // future edit drops that default (or adds a field the schema does not model), a cached decision
  // could pass `isValidRouterCacheJson` and then fail the type it is asserted to have.
  const decisions = [
    { action: 'direct_answer', reasoning: 'answer directly' },
    { action: 'web_search', reasoning: 'search', query: 'weather' },
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
