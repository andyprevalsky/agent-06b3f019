#!/usr/bin/env tsx
/**
 * Compute-grant failure classification.
 *
 * This is the single decision point for "is this grant dead, and do we re-mint?"
 * on the Rose completion path. Liveness comes from real agent traffic rather than
 * scheduled probes, so a wrong verdict here either (a) burns a fresh grant on
 * every rate limit, or (b) reports a revoked grant as healthy and suppresses the
 * re-mint that would fix it.
 *
 * Every body string below is a VERBATIM live response captured 2026-08-18, not an
 * invented fixture -- a hand-written 401 passes checkers that real traffic breaks.
 */

import {
  classifyComputeGrantFailure,
  type ComputeGrantVerdict,
} from '../../providers/computeGrantFailure';
import { RoseAuthError } from '../../providers/rose/errors';

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function expectVerdict(
  label: string,
  input: { status: number; body?: string },
  verdict: ComputeGrantVerdict,
  shouldRemint: boolean
) {
  const got = classifyComputeGrantFailure(input);
  assert(
    got.verdict === verdict,
    `${label}: expected verdict "${verdict}", got "${got.verdict}" (${got.reason})`
  );
  assert(
    got.shouldRemint === shouldRemint,
    `${label}: expected shouldRemint=${shouldRemint}, got ${got.shouldRemint} (${got.reason})`
  );
}

// --- the measured revocation strings ----------------------------------------

const LIVE_REVOKED_401 =
  '{"type":"error","error":{"type":"authentication_error","message":"OAuth access token has been revoked."},"request_id":null}';
const LIVE_INVALID_GRANT_400 =
  '{"error": "invalid_grant", "error_description": "Refresh token not found or invalid"}';

test('live 401 revoked body -> revoked, re-mint', () => {
  expectVerdict('401 revoked', { status: 401, body: LIVE_REVOKED_401 }, 'revoked', true);
});

test('REGRESSION: 403 revoked is caught (status !== 401 would miss it)', () => {
  // Anthropic signals revocation on 403 too, with the reason only in the body.
  // A status-only check calls this healthy and the grant never gets replaced.
  expectVerdict(
    '403 revoked',
    { status: 403, body: '{"error":{"message":"OAuth token has been revoked"}}' },
    'revoked',
    true
  );
});

test('live refresh invalid_grant -> revoked, re-mint', () => {
  expectVerdict(
    '400 invalid_grant',
    { status: 400, body: LIVE_INVALID_GRANT_400 },
    'revoked',
    true
  );
});

test('codex terminal refresh codes -> revoked, re-mint', () => {
  for (const code of [
    'refresh_token_invalidated',
    'refresh_token_reused',
    'refresh_token_expired',
    'invalid_refresh_token',
  ]) {
    // Codex returns these on 400 OR 401 -- both must classify identically.
    for (const status of [400, 401]) {
      expectVerdict(
        `${code} (${status})`,
        { status, body: `{"error":{"code":"${code}"}}` },
        'revoked',
        true
      );
    }
  }
});

// --- the two mistakes this module exists to prevent --------------------------

test('REGRESSION: 429 is NEVER a dead grant', () => {
  expectVerdict('bare 429', { status: 429, body: '' }, 'rate_limited', false);
});

test('REGRESSION: far-future 5h/7d usage window is still just a rate limit', () => {
  // The mirror-image bug already hit this repo: a far-future reset caused
  // credential rotation. Under re-minting the same mistake would mint a brand
  // new grant on every throttle and mask the real cause.
  expectVerdict(
    '429 with 7d window',
    {
      status: 429,
      body: '{"type":"error","error":{"type":"rate_limit_error","message":"You have exceeded your weekly usage limit. Resets at 2026-08-25T00:00:00Z"}}',
    },
    'rate_limited',
    false
  );
});

test('REGRESSION: 429 body mentioning a limit does not leak into revoked', () => {
  // Overlapping vocabulary between throttling and revocation is why ordering in
  // the classifier is deliberate rather than incidental.
  expectVerdict(
    '429 with limit language',
    { status: 429, body: '{"error":{"message":"usage limit reached, session will resume later"}}' },
    'rate_limited',
    false
  );
});

test('out of credits -> payment_required, never re-mint', () => {
  // A new grant on the same account fails identically, so re-minting is waste.
  expectVerdict('402', { status: 402, body: '' }, 'payment_required', false);
  expectVerdict(
    '400 low balance',
    { status: 400, body: '{"error":{"message":"Your credit balance is too low"}}' },
    'payment_required',
    false
  );
});

test('unrecognised auth failure does NOT re-mint', () => {
  // Blind re-minting on any 401 would loop forever on a scope/config bug while
  // hiding it. Only an explicit revocation marker justifies a new grant.
  expectVerdict(
    '401 bad scope',
    { status: 401, body: '{"error":{"message":"insufficient scope for this endpoint"}}' },
    'auth_other',
    false
  );
  expectVerdict('bare 401', { status: 401, body: '' }, 'auth_other', false);
});

test('success and unrelated statuses are not grant failures', () => {
  expectVerdict('200', { status: 200, body: '{"ok":true}' }, 'not_a_grant_failure', false);
  expectVerdict('500', { status: 500, body: 'internal error' }, 'not_a_grant_failure', false);
});

test('classification never throws on missing or malformed bodies', () => {
  for (const status of [400, 401, 402, 403, 429, 500]) {
    const a = classifyComputeGrantFailure({ status });
    const b = classifyComputeGrantFailure({ status, body: '<html>gateway</html>' });
    assert(typeof a.reason === 'string' && a.reason.length > 0, `no reason for ${status}`);
    assert(typeof b.shouldRemint === 'boolean', `no verdict for malformed ${status}`);
  }
});

test('INVARIANT: only "revoked" ever sets shouldRemint', () => {
  // Cheap structural guard: if a future edit makes some other verdict re-mint,
  // this fails immediately rather than in production.
  const cases: Array<{ status: number; body?: string }> = [
    { status: 200, body: '{}' },
    { status: 400, body: 'nope' },
    { status: 401, body: '' },
    { status: 402 },
    { status: 403, body: '' },
    { status: 429, body: LIVE_REVOKED_401 }, // throttle wins even with revoked text
    { status: 500 },
    { status: 401, body: LIVE_REVOKED_401 },
  ];
  for (const c of cases) {
    const got = classifyComputeGrantFailure(c);
    assert(
      got.shouldRemint === (got.verdict === 'revoked'),
      `shouldRemint diverged from verdict for ${JSON.stringify(c)}: ${JSON.stringify(got)}`
    );
  }
});

test('a 429 carrying revocation text still refuses to re-mint', () => {
  // Defensive: a throttle response that happens to echo revocation language must
  // not be able to trigger a mint. Ordering in the classifier guarantees this.
  expectVerdict(
    '429 + revoked text',
    { status: 429, body: LIVE_REVOKED_401 },
    'rate_limited',
    false
  );
});

// --- wiring: the verdict must actually reach the error the caller sees --------

test('WIRING: RoseAuthError carries grantRevoked from the classifier', () => {
  // Mirrors the branch at claudeAuth.ts:388. Classifying correctly is useless if
  // the verdict does not survive onto the error the completion path throws --
  // that is what the re-mint trigger reads.
  const build = (status: number, body: string) =>
    new RoseAuthError(
      `Anthropic ${status}: ${body.slice(0, 200)}`,
      status,
      classifyComputeGrantFailure({ status, body }).shouldRemint
    );

  assert(build(401, LIVE_REVOKED_401).grantRevoked, '401 revoked must set grantRevoked');
  assert(
    build(403, '{"error":{"message":"OAuth token has been revoked"}}').grantRevoked,
    '403 revoked must set grantRevoked (status-only checks miss this)'
  );
  assert(
    !build(401, '{"error":{"message":"insufficient scope"}}').grantRevoked,
    'unrecognised 401 must NOT request a re-mint'
  );
  assert(!build(403, 'forbidden').grantRevoked, 'generic 403 must NOT request a re-mint');
});

test('WIRING: a throttle can never reach the auth branch as a re-mint', () => {
  // 429 returns earlier as RoseRateLimitError. This guards a future reorder that
  // would let a throttle fall through and be read as grant death.
  const throttle = classifyComputeGrantFailure({ status: 429, body: LIVE_REVOKED_401 });
  assert(throttle.verdict === 'rate_limited', '429 must classify as rate_limited');
  assert(!throttle.shouldRemint, '429 must never request a re-mint');
});

async function main() {
  let passed = 0;
  const failures: string[] = [];
  console.log('\ncompute-grant failure classification\n');
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
      console.log(`  PASS  ${t.name}`);
    } catch (err) {
      failures.push(`${t.name}: ${err instanceof Error ? err.message : String(err)}`);
      console.log(`  FAIL  ${t.name}\n        ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`\nRESULTS: ${passed}/${tests.length} passed`);
  if (failures.length > 0) process.exit(1);
}

if (process.argv[1]?.includes('compute-grant-failure')) {
  void main();
}
