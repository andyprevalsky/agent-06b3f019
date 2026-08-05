#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  codexSmokeCreditSkipReason,
  detectCodexCreditExhaustion,
} from '../blackbox/codex-credit-skip';

// Regression coverage for the Codex E2B smoke's out-of-funds skip.
//
// The module documents itself as "cemented by regression cases without a live
// sandbox" — but no such cases existed, and the gap cost a deploy: on
// 2026-08-04 the OpenAI org ran out of credits and the smoke HARD-FAILED
// instead of skipping, because the pattern never matched the API's actual
// wording ("You have no credits remaining. Add credits to continue using the
// API"). These cases pin both halves of the contract: every real funding
// signal skips, and nothing else does.

/** The verbatim terminal event text that hard-failed the 2026-08-04 deploy. */
const REAL_OPENAI_EXHAUSTION =
  'stream disconnected before completion: You have no credits remaining. ' +
  'Add credits to continue using the API at ' +
  'https://platform.openai.com/settings/organization/billing/.';

test('skips on the exact OpenAI out-of-credits wording (2026-08-04 regression)', () => {
  assert.ok(detectCodexCreditExhaustion(REAL_OPENAI_EXHAUSTION, []) !== null);
  assert.ok(codexSmokeCreditSkipReason(REAL_OPENAI_EXHAUSTION, []) !== null);
});

test('skips when the funding signal arrives only in a structured event', () => {
  const events = [{ type: 'error', message: REAL_OPENAI_EXHAUSTION }];
  assert.ok(codexSmokeCreditSkipReason('', events) !== null);
});

test('skips on every other known funding signal', () => {
  for (const signal of [
    'insufficient_quota',
    'insufficient credits',
    'quota exceeded',
    'You exceeded your current quota, please check your plan and billing details',
    'HTTP 402 Payment Required',
    'You hit your usage limit',
    'purchase more credits',
    'out of credits',
    'billing hard limit reached',
  ]) {
    assert.ok(
      detectCodexCreditExhaustion(signal, []) !== null,
      `expected a funding skip for: ${signal}`
    );
  }
});

test('does NOT skip on auth/OAuth revocation — that must stay a hard failure', () => {
  for (const signal of [
    '401 Unauthorized',
    'Please log out and sign in again',
    'authentication failed',
    'invalid_api_key',
    'token has been revoked',
  ]) {
    assert.equal(
      detectCodexCreditExhaustion(signal, []),
      null,
      `auth error must not be treated as a funding skip: ${signal}`
    );
  }
});

test('does NOT skip on ordinary failures (crash, timeout, wrong output)', () => {
  for (const signal of [
    'Error: sandbox exited with code 137',
    'timed out after 300000ms',
    'command not found: codex',
    '',
  ]) {
    assert.equal(detectCodexCreditExhaustion(signal, []), null, `must not skip: ${signal}`);
  }
});

test('success always wins — a completed run can never skip', () => {
  // A run that recovered via the funded key still prints the recoverable
  // usage-limit text; the sentinel must veto the skip.
  const recovered = `You hit your usage limit on ChatGPT, falling back...\nCODEX_E2B_DONE\n`;
  assert.equal(codexSmokeCreditSkipReason(recovered, []), null);
  assert.equal(
    codexSmokeCreditSkipReason(`CODEX_E2B_DONE`, [{ message: REAL_OPENAI_EXHAUSTION }]),
    null
  );
});

test('a bare version number containing 402 is not a payment error', () => {
  assert.equal(detectCodexCreditExhaustion('codex-cli v1.402.0 started', []), null);
});
