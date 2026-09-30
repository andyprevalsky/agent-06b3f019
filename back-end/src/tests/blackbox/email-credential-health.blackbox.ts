#!/usr/bin/env tsx
/**
 * Email credential health classification.
 *
 * This is the single decision point for "must the user reconnect this account?"
 * A wrong verdict here is expensive in both directions:
 *
 *   (a) too eager -- a rotated OAuth client secret makes Google reject EVERY
 *       refresh with a 400. Classifying that as terminal would light up
 *       "Needs Reconnection" on every account in the product and march users
 *       through an OAuth flow that cannot succeed, hiding a deploy-time fault
 *       behind what looks like normal user churn.
 *
 *   (b) too lax -- a genuinely revoked grant reported as transient means the
 *       cron retries a guaranteed-400 forever and the user is never told their
 *       email stopped syncing. That is the bug this feature exists to fix:
 *       andyprevalsky111@gmail.com sat dead for 5 weeks behind a rose
 *       "Connected" chip.
 *
 * The `invalid_grant` body below is VERBATIM from back-end/backend-logs.log on
 * 2026-08-19, captured off the real dead account -- not an invented fixture.
 */

import {
  classifyEmailAuthFailure,
  type EmailCredentialState,
} from '../../services/integrations/emailCredentialHealth';
import { GOOGLE_OAUTH_SCOPES, missingGoogleScopes } from '../../domains/integrations/googleScopes';
import { generateKeyPairSync } from 'crypto';
import {
  encryptGoogleToken,
  readGoogleToken,
  isGoogleTokenEncrypted,
} from '../../providers/googleCredentials';
import { revokeGoogleGrant } from '../../providers/googleRevoke';
import { redactGmailArchive } from '../../providers/traceArchiveGmailRedaction';

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function expectState(
  label: string,
  input: { status: number; body?: string },
  state: EmailCredentialState
) {
  const got = classifyEmailAuthFailure(input);
  assert(
    got.state === state,
    `${label}: expected state "${state}", got "${got.state}" (${got.reason})`
  );
  assert(
    typeof got.reason === 'string' && got.reason.length > 0,
    `${label}: every failure must carry a user-facing reason for the chip tooltip`
  );
}

// --- the measured failure bodies --------------------------------------------

/** Verbatim: the live body Google returned for the revoked account. */
const LIVE_INVALID_GRANT_400 =
  '{\n  "error": "invalid_grant",\n  "error_description": "Bad Request"\n}';

/** Google's shape when OUR client credentials are wrong, not the user's grant. */
const INVALID_CLIENT_400 =
  '{"error": "invalid_client", "error_description": "The OAuth client was not found."}';
const UNAUTHORIZED_CLIENT_400 =
  '{"error": "unauthorized_client", "error_description": "Unauthorized"}';

test('Google requests the approved scope set only', () => {
  assert(
    JSON.stringify(GOOGLE_OAUTH_SCOPES) ===
      JSON.stringify([
        'openid',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/gmail.modify',
        'https://www.googleapis.com/auth/calendar.events',
        'https://www.googleapis.com/auth/drive',
      ]),
    'OAuth scope list drifted from the production verification set'
  );
});

test('old Gmail grants require reconnect', () => {
  const missing = missingGoogleScopes([
    'openid',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
  ]);
  assert(missing.includes('https://www.googleapis.com/auth/gmail.modify'), 'modify is required');
  assert(missing.includes('https://www.googleapis.com/auth/drive'), 'Drive is required');
});

test('Google tokens use authenticated application encryption', () => {
  const previousKey = process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY;
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY = Buffer.from(
    privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  ).toString('base64');
  try {
    const stored = encryptGoogleToken('test-access-token');
    assert(isGoogleTokenEncrypted(stored), 'new tokens must carry the envelope marker');
    assert(!stored.includes('test-access-token'), 'stored token must not contain plaintext');
    assert(readGoogleToken(stored) === 'test-access-token', 'token must round-trip');
    assert(encryptGoogleToken(stored) === stored, 'writes must not double encrypt');
    assert(
      readGoogleToken('legacy-token') === 'legacy-token',
      'legacy rows remain readable for migration'
    );
  } finally {
    if (previousKey === undefined) delete process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY;
    else process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY = previousKey;
  }
});

test('disconnect revokes the decrypted refresh grant before local deletion', async () => {
  const previousKey = process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY;
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY = Buffer.from(
    privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  ).toString('base64');
  try {
    let revokedToken: string | null = null;
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      revokedToken = new URLSearchParams(init?.body as string).get('token');
      return new Response('', { status: 200 });
    }) as typeof fetch;
    await revokeGoogleGrant(
      encryptGoogleToken('refresh-test'),
      encryptGoogleToken('access-test'),
      fakeFetch
    );
    assert(revokedToken === 'refresh-test', 'the refresh grant must be revoked');
  } finally {
    if (previousKey === undefined) delete process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY;
    else process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY = previousKey;
  }
});

test('Gmail provider traces omit bodies and recipient details', () => {
  const trace = redactGmailArchive({
    request: {
      method: 'POST',
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      body: { raw: 'secret-email-body' },
    },
    context: { user_id: 'user-1', to: 'private@example.com', subject: 'private subject' },
    status_code: 200,
  });
  const serialized = JSON.stringify(trace);
  assert(!serialized.includes('secret-email-body'), 'the message body must be removed');
  assert(!serialized.includes('private@example.com'), 'recipient must be removed');
  assert(!serialized.includes('private subject'), 'subject must be removed');
  assert(serialized.includes('200'), 'API status remains available for debugging');
});

// --- terminal: only re-consent can fix these --------------------------------

test('live invalid_grant 400 -> needs_reconnect', () => {
  expectState('invalid_grant', { status: 400, body: LIVE_INVALID_GRANT_400 }, 'needs_reconnect');
});

test('an explicitly revoked token -> needs_reconnect', () => {
  expectState(
    'token_revoked',
    { status: 400, body: '{"error":"token_revoked"}' },
    'needs_reconnect'
  );
});

// --- NOT terminal: our fault or a transient one -----------------------------

test('invalid_client 400 -> sync_failed, never needs_reconnect', () => {
  // The single most important case in this file. A rotated client secret must
  // not tell every user in the product to reconnect.
  expectState('invalid_client', { status: 400, body: INVALID_CLIENT_400 }, 'sync_failed');
});

test('unauthorized_client 400 -> sync_failed, never needs_reconnect', () => {
  expectState('unauthorized_client', { status: 400, body: UNAUTHORIZED_CLIENT_400 }, 'sync_failed');
});

test('a bare 400 with no marker -> sync_failed', () => {
  expectState('bare 400', { status: 400, body: '' }, 'sync_failed');
});

test('a bare 401 with no revocation marker -> sync_failed', () => {
  // A 401 without a revocation marker is more likely a scope/config bug than a
  // dead grant; asking the user to reconnect would hide it.
  expectState('bare 401', { status: 401, body: '' }, 'sync_failed');
});

test('429 rate limiting -> sync_failed, never needs_reconnect', () => {
  expectState('429', { status: 429, body: 'Too Many Requests' }, 'sync_failed');
});

test('500 from Google -> sync_failed', () => {
  expectState('500', { status: 500, body: 'Internal Server Error' }, 'sync_failed');
});

test('a revocation marker anywhere in the body wins over the status code', () => {
  // Google is not consistent about which 4xx carries invalid_grant.
  for (const status of [400, 401, 403]) {
    expectState(
      `invalid_grant @${status}`,
      { status, body: LIVE_INVALID_GRANT_400 },
      'needs_reconnect'
    );
  }
});

async function main() {
  let passed = 0;
  const failures: string[] = [];
  console.log('\nemail credential health classification\n');
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

if (process.argv[1]?.includes('email-credential-health')) {
  void main();
}
