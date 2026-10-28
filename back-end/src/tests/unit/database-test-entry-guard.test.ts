#!/usr/bin/env tsx
/**
 * A test file run directly must not query a non-local database: back-end/.env's
 * DATABASE_URL is the production pooler (prod fixture rows on 2026-10-23 and
 * 2026-10-27). Server and script entries are untouched.
 */
import assert from 'node:assert';
import { testEntryRemoteDatabaseReason } from '../../providers/database';

const PROD = 'postgresql://u:p@aws-1-us-east-2.pooler.supabase.com:6543/postgres';
const LOCAL = 'postgresql://postgres:postgres@localhost:5432/victoria_ws';
const UNIT = '/repo/back-end/src/tests/unit/browser-session-control.test.ts';
const BLACKBOX = 'C:\\repo\\back-end\\src\\tests\\blackbox\\agents.blackbox.ts';

assert.match(String(testEntryRemoteDatabaseReason(UNIT, { DATABASE_URL: PROD })), /not local/);
assert.match(String(testEntryRemoteDatabaseReason(BLACKBOX, { DATABASE_URL: PROD })), /not local/);
assert.match(String(testEntryRemoteDatabaseReason(UNIT, {})), /not set/);
assert.strictEqual(testEntryRemoteDatabaseReason(UNIT, { DATABASE_URL: LOCAL }), null);
// Deliberate remote runs keep their existing escape hatches.
assert.strictEqual(
  testEntryRemoteDatabaseReason(UNIT, { DATABASE_URL: PROD, BACKEND_UNIT_ALLOW_REMOTE_DB: '1' }),
  null
);
assert.strictEqual(
  testEntryRemoteDatabaseReason(BLACKBOX, {
    DATABASE_URL: PROD,
    BLACKBOX_TEST_ALLOW_REMOTE_DATABASE: '1',
  }),
  null
);
// The server and operator scripts are not test entries.
assert.strictEqual(
  testEntryRemoteDatabaseReason('/app/back-end/src/bootstrap.ts', { DATABASE_URL: PROD }),
  null
);
assert.strictEqual(
  testEntryRemoteDatabaseReason('/app/back-end/scripts/prod-health.ts', { DATABASE_URL: PROD }),
  null
);
assert.strictEqual(testEntryRemoteDatabaseReason('', { DATABASE_URL: PROD }), null);

process.stdout.write('PASS direct test entries refuse a non-local database\n');
