#!/usr/bin/env tsx

import assert from 'node:assert';
import { resolveTaskInfoProfileId } from '../../domains/browser-session/service.task-info';

const sharedContext = {
  contextId: 'shared-steel-profile',
  providerProfiles: [{ provider: 'kernel', profileId: 'shared-kernel-profile' }],
};

assert.strictEqual(
  resolveTaskInfoProfileId({
    provider: 'steel',
    providerProfileId: 'session-bound-steel-profile',
    providerProfileSource: 'steel_session_auth_read_only',
    context: sharedContext,
  }),
  'session-bound-steel-profile',
  'a new session binding must beat a conflicting shared BrowserContext profile'
);

assert.strictEqual(
  resolveTaskInfoProfileId({
    provider: 'steel',
    providerProfileId: null,
    providerProfileSource: 'local',
    context: sharedContext,
  }),
  null,
  'an explicit profile-free session must not fall back to shared state'
);

assert.strictEqual(
  resolveTaskInfoProfileId({
    provider: 'steel',
    providerProfileId: null,
    providerProfileSource: null,
    context: sharedContext,
  }),
  'shared-steel-profile',
  'a pre-migration Steel session must preserve legacy reporting metadata'
);

assert.strictEqual(
  resolveTaskInfoProfileId({
    provider: 'kernel',
    providerProfileId: null,
    providerProfileSource: null,
    context: sharedContext,
  }),
  'shared-kernel-profile',
  'a pre-migration Kernel session must preserve legacy reporting metadata'
);

process.stdout.write('PASS browser session profile binding compatibility\n');
