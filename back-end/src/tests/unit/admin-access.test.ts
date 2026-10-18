#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { isAdminUser, ADMIN_USER_IDS } from '../../utils/adminAccess';

const ANDY = '1f85ff25-6e29-4c1b-8739-f917bd101a30';
const TAMY = '43c2f6ae-37c0-42d0-bd88-2d6fc335b9e9';
// Andy's duplicate account, merged into ANDY and deleted on 2026-10-18.
const ANDY_MERGED = 'c49b4ce3-3489-499d-bfbd-846d04ba6275';
const SYNTH = '00000000-0000-4000-8000-000000000105';
const RANDO = 'not-an-admin';

// Hardcoded prod allowlist.
assert.equal(ADMIN_USER_IDS.has(ANDY), true, 'Andy current id is a hardcoded admin');
assert.equal(ADMIN_USER_IDS.has(ANDY_MERGED), false, 'the deleted merged Andy id is not admin');
assert.equal(
  ADMIN_USER_IDS.has('8283e892-b0a4-4298-9ef7-b95bcc67e46b'),
  true,
  'Tamara current id is a hardcoded admin'
);
assert.equal(isAdminUser(ANDY), true);
assert.equal(isAdminUser(ANDY_MERGED), false);
assert.equal(isAdminUser(TAMY), true);
assert.equal(isAdminUser('8283e892-b0a4-4298-9ef7-b95bcc67e46b'), true);
assert.equal(isAdminUser(RANDO), false);
assert.equal(isAdminUser(undefined), false);

// Env-extensible allowlist (used only by non-prod stacks like the benchmark harness).
const prev = process.env.ADMIN_USER_IDS_EXTRA;
try {
  delete process.env.ADMIN_USER_IDS_EXTRA;
  assert.equal(isAdminUser(SYNTH), false, 'synthetic user is not admin without env');

  process.env.ADMIN_USER_IDS_EXTRA = ` ${SYNTH} , other-id `;
  assert.equal(isAdminUser(SYNTH), true, 'env-listed synthetic user is admin');
  assert.equal(isAdminUser('other-id'), true, 'trims and honors multiple env ids');
  assert.equal(isAdminUser(ANDY), true, 'hardcoded admins remain admin with env set');
  assert.equal(isAdminUser(RANDO), false, 'non-listed user still not admin');

  process.env.ADMIN_USER_IDS_EXTRA = '';
  assert.equal(isAdminUser(SYNTH), false, 'empty env grants no extra admins');
} finally {
  if (prev === undefined) delete process.env.ADMIN_USER_IDS_EXTRA;
  else process.env.ADMIN_USER_IDS_EXTRA = prev;
}
