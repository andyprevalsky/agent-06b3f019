#!/usr/bin/env tsx
/* eslint-disable no-console */

import assert from 'node:assert/strict';
import {
  applyResolvedBenchmarkAgentCardIds,
  resolveBenchmarkAgentCardIds,
} from '../../domains/test-payment/config';

function main(): void {
  // Truncated Cursor-injected org id falls back to AGENTCARD_ORG_ID.
  {
    const resolved = resolveBenchmarkAgentCardIds({
      BENCHMARK_AGENTCARD_ORG_ID: 'cmqr3fk',
      BENCHMARK_AGENTCARD_CARDHOLDER_ID: 'cmrs8yyyyyyyyyyyyyyyyy7jg',
      AGENTCARD_ORG_ID: 'cmqr3fkkkkkkkkkkkkkkkiu0z',
      AGENTCARD_CARDHOLDER_ID: 'cmrfpzzzzzzzzzzzzzzzzzgfto',
    });
    assert.equal(resolved.orgId, 'cmqr3fkkkkkkkkkkkkkkkiu0z');
    assert.equal(resolved.cardholderId, 'cmrs8yyyyyyyyyyyyyyyyy7jg');
  }

  // Truncated cardholder falls back to AGENTCARD_CARDHOLDER_ID.
  {
    const resolved = resolveBenchmarkAgentCardIds({
      BENCHMARK_AGENTCARD_ORG_ID: 'cmqr3fkkkkkkkkkkkkkkkiu0z',
      BENCHMARK_AGENTCARD_CARDHOLDER_ID: 'short',
      AGENTCARD_ORG_ID: 'cmqr3fkkkkkkkkkkkkkkkiu0z',
      AGENTCARD_CARDHOLDER_ID: 'cmrfpzzzzzzzzzzzzzzzzzgfto',
    });
    assert.equal(resolved.cardholderId, 'cmrfpzzzzzzzzzzzzzzzzzgfto');
  }

  // applyResolvedBenchmarkAgentCardIds mutates env in place.
  {
    const env: NodeJS.ProcessEnv = {
      BENCHMARK_AGENTCARD_ORG_ID: 'cmqr3fk',
      AGENTCARD_ORG_ID: 'cmqr3fkkkkkkkkkkkkkkkiu0z',
      AGENTCARD_CARDHOLDER_ID: 'cmrfpzzzzzzzzzzzzzzzzzgfto',
    };
    const resolved = applyResolvedBenchmarkAgentCardIds(env);
    assert.equal(env.BENCHMARK_AGENTCARD_ORG_ID, 'cmqr3fkkkkkkkkkkkkkkkiu0z');
    assert.equal(env.BENCHMARK_AGENTCARD_CARDHOLDER_ID, 'cmrfpzzzzzzzzzzzzzzzzzgfto');
    assert.deepEqual(resolved, {
      orgId: 'cmqr3fkkkkkkkkkkkkkkkiu0z',
      cardholderId: 'cmrfpzzzzzzzzzzzzzzzzzgfto',
    });
  }

  console.log('benchmark-agentcard-ids: all assertions passed');
}

main();
