import assert from 'node:assert/strict';
import { calculateTaskCostPerTask } from '../../domains/admin-health/costs';

/** Actual ledger model identities: subscription, direct API and Azure Foundry. */
export async function testSol61ApiEquivalentCosts(): Promise<void> {
  const taskId = 'sol61-cost-regression';
  for (const model of [
    'gpt-6.1-sol-gpt', 'gpt-6.1-sol-openai', 'gpt-6.1-sol-foundry',
    'gpt-6.1-sol', 'openai/gpt-6.1-sol',
  ]) {
    for (const [bucket, expected] of [
      ['input', 2], ['output', 10], ['read', 0.1], ['write', 2.5],
    ] as const) {
      const result = calculateTaskCostPerTask([{ taskId }], [{
        taskId, kind: 'llm', model, fromFastCache: false, costCents: 0,
        tokensIn: bucket === 'output' ? 0 : 1_000_000,
        tokensOut: bucket === 'output' ? 1_000_000 : 0,
        cacheReadInputTokens: bucket === 'read' ? 1_000_000 : 0,
        cacheCreationInputTokens: bucket === 'write' ? 1_000_000 : 0,
      }]);
      assert.equal(result.apiRateDollars, expected, `${model} ${bucket} API-equivalent rate`);
      assert.equal(result.unpricedUsageTokens, 0, `${model} ${bucket} coverage`);
      assert.equal(result.computeTokenRateDollars, expected / 20);
      assert.equal(result.zeroLlmCostDollars, 0);
    }
  }
  const unknown = calculateTaskCostPerTask([{ taskId }], [{
    taskId, kind: 'llm', model: 'unknown-model-foundry', fromFastCache: false,
    costCents: 0, tokensIn: 123, tokensOut: 0, cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  }]);
  assert.equal(unknown.unpricedUsageTokens, 123, 'Unknown Foundry identities remain unpriced');
}
