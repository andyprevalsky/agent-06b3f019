import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  verificationDto,
  CONFIG_TARGETS,
  SETUP_REQUIREMENTS_VERSION,
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
  expectedGoogleIdentity: 'google@example.invalid',
  floorAt: new Date(now.getTime() - 1000).toISOString(),
  floorCursor: 0,
  now,
};
function fixture(): SetupChecks {
  return {
    requirementsVersion: SETUP_REQUIREMENTS_VERSION,
    checks: Object.fromEntries(
      [...CONFIG_TARGETS, 'runtime'].map((target) => [
        target,
        {
          status: 'confirmed',
          observedAt: now.toISOString(),
          evidenceDigest: 'digest',
          requirementsVersion: SETUP_REQUIREMENTS_VERSION,
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

test('portrait lock is a required version-two boot setting, not inferred from portrait dimensions', () => {
  const current = fixture();
  assert.equal(verificationDto(current, context).configurationReady, true);
  delete current.checks.portrait_lock;
  assert.equal(
    verificationDto(current, context).configurationReady,
    false,
    'Removing only portrait lock must invalidate boot readiness'
  );
  const old = fixture();
  old.requirementsVersion = 1;
  const result = verificationDto(old, context);
  assert.equal(result.requirementsVersion, SETUP_REQUIREMENTS_VERSION);
  assert.equal(result.configurationReady, false);
});

test('upgraded envelope cannot revive prior requirements-version proofs', () => {
  const state = fixture();
  for (const proof of Object.values(state.checks)) if (proof) delete proof.requirementsVersion;
  assert.equal(verificationDto(state, context).configurationReady, false);
});

test('Contacts sync is a required version-three startup setting', () => {
  const state = fixture();
  const result = verificationDto(state, context);
  assert.equal(result.requirementsVersion, SETUP_REQUIREMENTS_VERSION);
  assert.ok(Object.hasOwn(result.checks, 'icloud_contacts'), 'Required Contacts sync check absent');
  assert.equal(result.configurationReady, true);
  const legacy = fixture();
  legacy.requirementsVersion = 2;
  assert.equal(verificationDto(legacy, context).configurationReady, false);
  const checks = state.checks as Record<string, unknown>;
  delete checks.icloud_contacts;
  assert.equal(
    verificationDto(state, context).configurationReady,
    false,
    'Other settings must not substitute for Contacts synchronization'
  );
});

test('Gmail installed and correct Google account is required by version-four startup', () => {
  const state = fixture();
  assert.equal(verificationDto(state, context).requirementsVersion, SETUP_REQUIREMENTS_VERSION);
  delete (state.checks as Record<string, unknown>).gmail;
  assert.equal(verificationDto(state, context).configurationReady, false);
});

test('configuration cannot be ready without server-configured Google identity even with confirmed facts', () => {
  assert.equal(
    verificationDto(fixture(), { ...context, expectedGoogleIdentity: undefined })
      .configurationReady,
    false
  );
});

test('device passcode is required before Gmail and absence cannot satisfy boot configuration', () => {
  assert.ok(CONFIG_TARGETS.includes('device_passcode' as (typeof CONFIG_TARGETS)[number]));
  assert.ok(
    CONFIG_TARGETS.indexOf('device_passcode' as (typeof CONFIG_TARGETS)[number]) <
      CONFIG_TARGETS.indexOf('gmail')
  );
  const state = fixture();
  delete (state.checks as Record<string, unknown>).device_passcode;
  assert.equal(verificationDto(state, context).configurationReady, false);
});

test('Google exception is an explicit current authorization alternative, never fake passcode enabled', () => {
  const state = fixture();
  delete (state.checks as Record<string, unknown>).device_passcode;
  (state.checks as Record<string, unknown>).google_passcode_exception = { ...state.checks.gmail };
  assert.equal(verificationDto(state, context).configurationReady, false);
  const opted = { ...context, allowGooglePasscodeException: true };
  const result = verificationDto(state, opted) as ReturnType<typeof verificationDto> & {
    securityDisposition?: string;
  };
  assert.equal(result.configurationReady, true);
  assert.equal(result.securityDisposition, 'authorized_google_exception');
  assert.equal(result.checks.device_passcode.status, 'unknown');
  (state.checks as Record<string, unknown>).google_passcode_exception = {
    ...state.checks.gmail,
    status: 'unknown',
  };
  assert.equal(verificationDto(state, opted).configurationReady, false);
});
