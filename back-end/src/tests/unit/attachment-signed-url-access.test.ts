#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { canAccessAttachmentPath } from '../../domains/agents/agentAttachmentService';

const OWNER = '00000000-0000-4000-8000-000000000107';
const ANDY = '1f85ff25-6e29-4c1b-8739-f917bd101a30';
const STRANGER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RECORDING = `${OWNER}/8cd3104b-b150-49a2-bbac-1463de1ba190_browser-recording.html`;

assert.equal(
  canAccessAttachmentPath({
    requesterUserId: OWNER,
    storagePath: RECORDING,
    isAdmin: false,
  }),
  true,
  'owner can sign their own recording path'
);

assert.equal(
  canAccessAttachmentPath({
    requesterUserId: ANDY,
    storagePath: RECORDING,
    isAdmin: false,
  }),
  false,
  'non-admin cannot sign another user recording path'
);

assert.equal(
  canAccessAttachmentPath({
    requesterUserId: ANDY,
    storagePath: RECORDING,
    isAdmin: true,
  }),
  false,
  'admin cannot sign another user path without the viewed agent owner'
);

assert.equal(
  canAccessAttachmentPath({
    requesterUserId: ANDY,
    storagePath: RECORDING,
    agentOwnerUserId: OWNER,
    isAdmin: true,
  }),
  true,
  'admin can sign a recording stored under the inspected agent owner'
);

assert.equal(
  canAccessAttachmentPath({
    requesterUserId: ANDY,
    storagePath: `${STRANGER}/other.html`,
    agentOwnerUserId: OWNER,
    isAdmin: true,
  }),
  false,
  'admin cannot sign a path that is not the inspected agent owner'
);

assert.equal(
  canAccessAttachmentPath({
    requesterUserId: STRANGER,
    storagePath: RECORDING,
    agentOwnerUserId: OWNER,
    isAdmin: false,
  }),
  false,
  'stranger non-admin cannot use admin-looking owner metadata'
);
