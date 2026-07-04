#!/usr/bin/env tsx
/**
 * Deterministic coverage for the provider credential-failure heuristic path.
 *
 * With the LLM disabled, classifyFailureBestEffort falls back to the regex-based
 * heuristicDecision. Each scenario below pins one branch (success, completed
 * credential auth-failure, captcha, antibot, rate-limit, account-locked,
 * auth-failed, task-level) so the classifier's offline behavior is locked down.
 */

import { config } from 'dotenv';
import {
  aggregateDecision,
  classifyFailureBestEffort,
  type CredentialRef,
} from '../../providers/credentialPropagationClassifier';

config();

type TestFn = () => Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
const test = (name: string, fn: TestFn) => tests.push({ name, fn });
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const REF: CredentialRef = { kind: 'password', id: 'pw-heuristic' };

async function classify(status: 'FAILED' | 'COMPLETED', text: string) {
  process.env.CREDENTIAL_PROPAGATION_DISABLE_LLM = '1';
  try {
    return await classifyFailureBestEffort(
      { id: 'heuristic-agent', goal: 'Sign in', status, statusMessage: '' },
      [{ role: 'TOOL', text, metadata: null }],
      [REF]
    );
  } finally {
    delete process.env.CREDENTIAL_PROPAGATION_DISABLE_LLM;
  }
}

const CASES: Array<{
  name: string;
  status: 'FAILED' | 'COMPLETED';
  text: string;
  outcome: string;
}> = [
  { name: 'completed run -> success', status: 'COMPLETED', text: 'all done', outcome: 'success' },
  {
    name: 'completed but saved credential rejected -> auth_failed',
    status: 'COMPLETED',
    text: 'Authentication failure state reached: yes. The saved credential was rejected.',
    outcome: 'auth_failed',
  },
  {
    name: 'captcha -> captcha',
    status: 'FAILED',
    text: 'hcaptcha challenge appeared',
    outcome: 'captcha',
  },
  {
    name: 'antibot -> antibot',
    status: 'FAILED',
    text: 'Cloudflare access denied to this browser',
    outcome: 'antibot',
  },
  {
    name: 'rate limit -> rate_limited',
    status: 'FAILED',
    text: 'HTTP 429 too many requests, try again later',
    outcome: 'rate_limited',
  },
  {
    name: 'account locked -> account_locked',
    status: 'FAILED',
    text: 'your account locked for suspicious activity',
    outcome: 'account_locked',
  },
  {
    name: 'invalid password -> auth_failed',
    status: 'FAILED',
    text: 'invalid password entered on login page',
    outcome: 'auth_failed',
  },
  {
    name: 'unrecognized failure -> task_level',
    status: 'FAILED',
    text: 'the product page failed to load',
    outcome: 'task_level',
  },
];

for (const c of CASES) {
  test(`heuristic: ${c.name}`, async () => {
    const decision = await classify(c.status, c.text);
    assert(
      decision.outcome === c.outcome,
      `expected ${c.outcome} for "${c.text}", got ${decision.outcome}`
    );
  });
}

test('aggregateDecision returns unknown for an empty decision set', async () => {
  const decision = aggregateDecision([], 'no decisions');
  assert(decision.outcome === 'unknown', 'expected unknown outcome for empty set');
  assert(decision.failureReason === null, 'expected null failure reason for empty set');
});

async function main() {
  const results: Array<{ name: string; passed: boolean }> = [];
  for (const item of tests) {
    try {
      await item.fn();
      results.push({ name: item.name, passed: true });
      console.log(`PASS ${item.name}`);
    } catch (error) {
      results.push({ name: item.name, passed: false });
      console.error(`FAIL ${item.name}`);
      console.error(error instanceof Error ? error.stack || error.message : String(error));
    }
  }
  const failed = results.filter((r) => !r.passed);
  console.log(`\nResults: ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
