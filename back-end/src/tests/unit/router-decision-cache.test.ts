#!/usr/bin/env tsx

import assert from 'node:assert';
import 'dotenv/config';

import {
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
}

main();
