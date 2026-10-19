import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  verificationDto,
  CONFIG_TARGETS,
  validSetupChecks,
  type SetupChecks,
} from '../../providers/phoneSetupVerification';
const now = new Date('2026-10-19T03:00:00Z');
const context = {
  attemptId: 'attempt',
  profileRevision: 1,
  workflowId: 'generation',
  providerEpoch: 2,
  expectedPhone: '+19729777432',
  floorAt: new Date(now.getTime() - 1000).toISOString(),
  floorCursor: 0,
  now,
};
function fixture(): SetupChecks {
  return {
    requirementsVersion: 1,
    checks: Object.fromEntries(
      [...CONFIG_TARGETS, 'runtime'].map((target) => [
        target,
        {
          status: 'confirmed',
          observedAt: now.toISOString(),
          evidenceDigest: 'digest',
          floorCursor: 0,
          attemptId: 'attempt',
          profileRevision: 1,
          workflowId: 'generation',
          providerEpoch: 2,
          expectedPhone: '+19729777432',
          ...(target === 'runtime'
            ? { runtime: { sync: 'syncing', activation: 'active', reason: 'unknown' } }
            : {}),
        },
      ])
    ),
  };
}
test('runtime requires current complete configuration and never trusts old or malformed envelope', () => {
  const state = fixture();
  assert.equal(verificationDto(state, context).operationalStatus, 'operational');
  delete state.checks.imessage;
  assert.equal(verificationDto(state, context).operationalStatus, 'unknown');
  const old = fixture();
  old.requirementsVersion = 0;
  assert.equal(verificationDto(old, context).operationalStatus, 'unknown');
  assert.equal(validSetupChecks({ requirementsVersion: 1, checks: { runtime: null } }), false);
});
test('runtime health ages out at 120s while same-startup configuration stays last-known current', () => {
  const state = fixture();
  state.checks.runtime!.observedAt = new Date(now.getTime() - 120001).toISOString();
  const runtimeContext = { ...context, floorAt: new Date(now.getTime() - 300000).toISOString() };
  const result = verificationDto(state, runtimeContext);
  assert.equal(result.checks.runtime.current, true);
  assert.equal(result.configurationReady, true);
  assert.equal(result.operationalStatus, 'unknown');
});
test('user interaction evidence floor invalidates prior configuration proof', () => {
  const result = verificationDto(fixture(), {
    ...context,
    floorAt: new Date(now.getTime() + 1).toISOString(),
  });
  assert.equal(result.configurationReady, false);
});

test('unknown runtime verdict cannot promote otherwise affirmative runtime fields', () => {
  const state = fixture();
  state.checks.runtime!.status = 'unknown';
  assert.equal(verificationDto(state, context).operationalStatus, 'unknown');
});

test('same-millisecond later custody floor invalidates prior proof by monotonic cursor', () => {
  const state = fixture();
  const result = verificationDto(state, { ...context, floorAt: now.toISOString(), floorCursor: 1 });
  assert.equal(result.configurationReady, false);
});
