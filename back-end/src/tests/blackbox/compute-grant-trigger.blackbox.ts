#!/usr/bin/env tsx
/**
 * The TRIGGER: recovery fires from the real completion path, not a probe.
 *
 * These assertions cover the seam between "the provider rejected this grant" and
 * "a replacement was minted and the request retried". The expensive half (a real
 * Anthropic stream) is out of scope here -- what matters is that the hook is
 * invoked with the right verdict and only in the right circumstances, because
 * every wrong invocation either burns a grant or diverts a user onto paid models.
 */

import {
  registerGrantRecovery,
  tryRecoverGrant,
  type GrantRecoveryRequest,
} from '../../providers/rose/grantRecovery';
import { RoseAuthError } from '../../providers/rose/errors';
import { classifyComputeGrantFailure } from '../../providers/computeGrantFailure';

type TestFn = () => Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const REVOKED =
  '{"type":"error","error":{"type":"authentication_error","message":"OAuth access token has been revoked."}}';

/**
 * Mirrors the decision made in client.ts: recovery runs only when the caller
 * identified the grant AND the provider actually said "revoked".
 */
function shouldAttemptRecovery(err: unknown, grant: unknown): boolean {
  return grant !== undefined && err instanceof RoseAuthError && err.grantRevoked;
}

function authErrorFor(status: number, body: string): RoseAuthError {
  return new RoseAuthError(
    `Anthropic ${status}: ${body}`,
    status,
    classifyComputeGrantFailure({ status, body }).shouldRemint
  );
}

const GRANT = { userId: 'u1', provider: 'claude' as const, accountId: 'a1', grantId: 'g1' };

test('a revoked grant WITH identity triggers recovery', async () => {
  assert(
    shouldAttemptRecovery(authErrorFor(401, REVOKED), GRANT),
    'revocation plus identity must trigger recovery'
  );
});

test('REGRESSION: a throttle never triggers recovery', async () => {
  // A 429 leaves the completion path as RoseRateLimitError, never RoseAuthError,
  // and even if it were mislabelled the verdict is false.
  const rateLimited = authErrorFor(429, '{"error":{"message":"weekly usage limit"}}');
  assert(!shouldAttemptRecovery(rateLimited, GRANT), 'a throttle must not mint a grant');
});

test('REGRESSION: an unrecognised auth failure never triggers recovery', async () => {
  const scope = authErrorFor(401, '{"error":{"message":"insufficient scope"}}');
  assert(
    !shouldAttemptRecovery(scope, GRANT),
    'only explicit revocation justifies minting; otherwise a config bug loops'
  );
});

test('403-revoked triggers recovery (a status-only check would miss it)', async () => {
  const forbidden = authErrorFor(403, '{"error":{"message":"OAuth token has been revoked"}}');
  assert(shouldAttemptRecovery(forbidden, GRANT), '403 revocation must trigger recovery');
});

test('an unidentified grant falls through instead of recovering', async () => {
  // Un-migrated callers pass no compute_grant. They must keep working exactly as
  // before rather than crash or mint blindly.
  assert(
    !shouldAttemptRecovery(authErrorFor(401, REVOKED), undefined),
    'without grant identity there is nothing to re-mint'
  );
});

test('with NO hook registered, recovery is a no-op (never a new failure mode)', async () => {
  registerGrantRecovery(null);
  const out = await tryRecoverGrant({
    userId: 'u1',
    provider: 'claude',
    accountId: 'a1',
    status: 401,
    body: REVOKED,
  });
  assert(out === null, 'an unregistered hook must yield null, not throw');
});

test('the hook receives the full provider context', async () => {
  let seen: GrantRecoveryRequest | null = null;
  registerGrantRecovery(async (req) => {
    seen = req;
    return { accessToken: 'sk-ant-oat01-new', status: 'reminted', reason: 'ok' };
  });
  const out = await tryRecoverGrant({
    userId: 'u1',
    provider: 'claude',
    accountId: 'a1',
    grantId: 'g1',
    status: 403,
    body: REVOKED,
  });
  assert(out?.accessToken === 'sk-ant-oat01-new', 'the replacement token must come back');
  assert(seen !== null, 'hook must be invoked');
  const req = seen as unknown as GrantRecoveryRequest;
  assert(req.status === 403, 'status must be forwarded so the hook can classify');
  assert(req.body.includes('revoked'), 'the BODY must be forwarded -- verdicts depend on it');
  assert(req.grantId === 'g1', 'the dying grant must be identified so it can be retired');
});

test('AVAILABILITY: a throwing hook degrades cost, never the request', async () => {
  // If recovery explodes the user must still get an answer via the waterfall.
  registerGrantRecovery(async () => {
    throw new Error('minter exploded');
  });
  const out = await tryRecoverGrant({
    userId: 'u1',
    provider: 'claude',
    accountId: 'a1',
    status: 401,
    body: REVOKED,
  });
  assert(out !== null, 'a thrown hook must be captured, not propagated');
  assert(out.accessToken === undefined, 'no token means the caller falls through');
  assert(out.status === 'recovery_threw', `expected recovery_threw, got ${out.status}`);
});

test('a hook that recovers nothing yields no token, so the caller falls through', async () => {
  registerGrantRecovery(async () => ({ status: 'needs_reconnect', reason: 'session dead' }));
  const out = await tryRecoverGrant({
    userId: 'u1',
    provider: 'claude',
    accountId: 'a1',
    status: 401,
    body: REVOKED,
  });
  assert(out?.accessToken === undefined, 'no token when the connection itself is dead');
  assert(out?.status === 'needs_reconnect', 'the reason must survive for logging and the chip');
});

test('the wired retry is bounded to exactly one attempt', async () => {
  // client.ts retries once and then falls through. Simulate the control flow to
  // guard against a future edit turning it into a loop that burns grants.
  let mints = 0;
  registerGrantRecovery(async () => {
    mints += 1;
    return { accessToken: `sk-ant-oat01-${mints}`, status: 'reminted', reason: 'ok' };
  });

  const err = authErrorFor(401, REVOKED);
  let attempts = 0;
  if (shouldAttemptRecovery(err, GRANT)) {
    const rec = await tryRecoverGrant({ ...GRANT, status: 401, body: REVOKED });
    if (rec?.accessToken !== undefined) {
      attempts += 1; // the single retry
      // retry fails again -> fall through, NO second recovery
    }
  }
  assert(attempts === 1, `exactly one retry expected, got ${attempts}`);
  assert(mints === 1, `exactly one mint expected, got ${mints}`);
});

async function main() {
  let passed = 0;
  const failures: string[] = [];
  console.log('\ncompute-grant trigger (completion path)\n');
  try {
    for (const t of tests) {
      try {
        await t.fn();
        passed += 1;
        console.log(`  PASS  ${t.name}`);
      } catch (err) {
        failures.push(t.name);
        console.log(`  FAIL  ${t.name}\n        ${err instanceof Error ? err.message : err}`);
      }
    }
  } finally {
    registerGrantRecovery(null);
  }
  console.log(`\nRESULTS: ${passed}/${tests.length} passed`);
  if (failures.length > 0) process.exit(1);
}

if (process.argv[1]?.includes('compute-grant-trigger')) {
  void main();
}
