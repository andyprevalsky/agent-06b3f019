#!/usr/bin/env tsx

import assert from 'node:assert';
import 'dotenv/config';

import { buildConnectorAdoption } from '../../domains/admin-health/connectorAdoption';

const adoption = buildConnectorAdoption(new Set(['browser-user', 'multi-user', 'password-user']), [
  { userId: 'browser-user', name: 'chrome' },
  { userId: 'browser-user', name: 'gmail' },
  { userId: 'browser-user', name: 'plaid' },
  { userId: 'multi-user', name: 'apple_passwords' },
  { userId: 'multi-user', name: 'claude_code' },
  { userId: 'multi-user', name: 'linkedin' },
  { userId: 'multi-user', name: 'whatsapp' },
  { userId: 'multi-user', name: 'telegram' },
  { userId: 'password-user', name: 'safari_passkeys' },
  { userId: 'outside-population', name: 'plaid' },
  { userId: 'outside-population', name: 'gmail' },
  { userId: 'browser-user', name: 'browser_fingerprint' },
]);

assert.strictEqual(adoption.eligibleUserCount, 3);
assert.deepStrictEqual(
  adoption.subtypes,
  [
    { id: 'browsers', label: 'Browser Sync', connectedUsers: 1, connectionRate: 0.3333 },
    { id: 'passwords', label: 'Passwords', connectedUsers: 2, connectionRate: 0.6667 },
    { id: 'compute', label: 'Compute', connectedUsers: 1, connectionRate: 0.3333 },
    { id: 'messages', label: 'Messages', connectedUsers: 2, connectionRate: 0.6667 },
    { id: 'socials', label: 'Socials', connectedUsers: 1, connectionRate: 0.3333 },
    { id: 'financials', label: 'Financials', connectedUsers: 1, connectionRate: 0.3333 },
  ],
  'Each eligible user must count at most once per connector subtype'
);

assert.deepStrictEqual(
  buildConnectorAdoption(new Set(), [{ userId: 'outside-population', name: 'gmail' }]).subtypes.map(
    ({ connectedUsers, connectionRate }) => ({ connectedUsers, connectionRate })
  ),
  Array.from({ length: 6 }, () => ({ connectedUsers: 0, connectionRate: 0 })),
  'An empty eligible population must report zero rates without dividing by zero'
);

process.stdout.write('admin-health connector adoption: passed\n');
