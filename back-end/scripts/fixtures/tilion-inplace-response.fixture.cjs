const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const src = require('node:fs').realpathSync(path.join(__dirname, '../../src/providers'));
let row,
  restores = 0,
  closes = 0,
  connects = 0,
  healthHook;
const clone = (value) => structuredClone(value);
const prisma = {
  browserSession: {
    findUnique: async () => clone(row),
    findUniqueOrThrow: async () => clone(row),
    updateMany: async ({ where, data }) => {
      if (where.sessionId && where.sessionId !== row.sessionId) return { count: 0 };
      if (where.status && where.status !== row.status) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
  },
  agent: { findUnique: async () => ({ proxyCountry: 'US' }) },
  $queryRaw: async (strings, ...values) => {
    assert(strings.join('?').includes('"proxyRotationCount"'));
    row.proxyRotationCount++;
    const out = {
      proxyRotationCount: row.proxyRotationCount,
      provider: row.provider,
    };
    if (strings.join('?').includes('RETURNING "proxyRotationCount", "provider", "sessionId"'))
      Object.assign(out, {
        sessionId: row.sessionId,
        contextId: row.contextId,
        logicalOwnerKey: row.logicalOwnerKey,
      });
    return [out];
  },
};
const health = async (id) => {
  if (healthHook) healthHook();
  return {
    provider: row.provider,
    sessionId: id,
    status: 'active',
    ttlMs: 600000,
  };
};
const mocks = {
  database: { prisma },
  logger: {
    createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
  },
  geoip: { DEFAULT_GEOLOCATION: { country: 'US' } },
  'steel/lifecycleClaim': {
    browserResumeScope: () => undefined,
    withBrowserResumeClaim: async () => {
      throw Error('unexpected claim');
    },
    withBrowserResumeLifecycle: async () => {
      throw Error('unexpected lifecycle');
    },
  },
  'steel/sessionConnection': {
    connectValidatedBrowser: async () => {
      connects++;
      throw Error('backend CDP forbidden for in-place rotation');
    },
  },
  'browser/checkpoint': {
    restoreLogicalBrowserCheckpoint: async () => {
      restores++;
    },
    loadLogicalBrowserCheckpoint: async () => {},
    checkpointLogicalBrowser: async () => {
      throw Error('unexpected checkpoint capture');
    },
  },
  'browser/sessionPersist': {
    isConfirmedBrowserEnd: (status) => ['closed', 'stopped', 'ended'].includes(status),
    recordEndedLogicalBrowser: async () => {},
  },
  'browser/initialization': { assertBrowserInitializationReady: () => {} },
  'browser/resumeRecovery': {
    inspectResumeCandidate: async () => {
      throw Error('unexpected inspect');
    },
  },
  'browser/resumeCredentialLookups': {
    findPasswords: async () => [],
    findUserSettings: async () => null,
    reservePasskeysForRealm: async () => [],
    toUserSettings: () => null,
  },
  browser: {
    getBrowserSessionHealth: health,
    getFingerprintInjectionData: async () => null,
    injectUserData: async () => {
      throw Error('unexpected injection');
    },
    getBrowserCaptchaTelemetry: async () => null,
  },
  browserSwitchCarry: {
    carryForTilionSwitch: async (_task, carry) => ({
      carry,
      fromPausedState: false,
    }),
    applyCarriedStateToReplacement: async () => {},
    withTilionSwitchCarry: async () => {
      throw Error('unexpected carry switch');
    },
  },
  'browser/tilionState': {
    clearPausedState: async () => {},
    restoreTilionBrowserState: async () => {
      throw Error('unexpected state restore');
    },
  },
  'browser/config': {
    browserUseEnabled: () => false,
    browserProviderEnabled: () => true,
  },
  'browser/rotation': {
    ROTATION_CAP: 4,
    selectRotationStep: () => ({
      provider: 'tilion',
      proxyType: 'residential',
      recoveryAction: 'ip_rotated',
    }),
    recoverySameProviderOnly: () => false,
    rotationStepLabel: () => '',
    isTilionExitUnavailableError: () => false,
    nextRecoveryLabel: () => 'switch_provider_to_kernel',
  },
};
const load = Module._load;
Module._load = function (id, parent, isMain) {
  if (parent?.filename.startsWith(src) && id.startsWith('.')) {
    const target = path.resolve(path.dirname(parent.filename), id).replace(/\.ts$/, '');
    const key = path.relative(src, target);
    if (Object.hasOwn(mocks, key)) return mocks[key];
  }
  return load.call(this, id, parent, isMain);
};
const { FakeTilionServer } = require('../../src/tests/unit/tilion-fake-server.support.ts');
const server = new FakeTilionServer();
async function main() {
  process.env.TILION_API_KEY = 'owned-fake-key';
  const native = require(path.join(src, 'browser/tilionRotateInPlace.ts'));
  const high = require(path.join(src, 'browserSessionResume.ts'));
  await server.start();
  process.env.TILION_BASE_URL = server.baseUrl;
  const outcomes = [];
  function reset() {
    row = {
      id: 'task-owned',
      sessionId: 'sess_owned',
      provider: 'tilion',
      status: 'ACTIVE',
      contextId: 'context-owned',
      context: { userId: 'user-owned' },
      logicalOwnerKey: 'agent:owned',
      controlState: 'AGENT',
      controlLeaseExpiresAt: null,
      wsUrl: 'ws://owned.invalid/cdp',
      debugUrl: 'https://owned.invalid/view',
      proxyTier: 'residential',
      proxyRotationCount: 0,
      currentUrl: 'https://example.com',
      startUrl: 'https://example.com',
      agentId: 'agent-owned',
    };
    restores = 0;
    closes = 0;
    connects = 0;
    healthHook = undefined;
    server.reset();
    server.route('POST', /\/rotate-ip$/, () => ({
      status: 200,
      body: { rotated: true, fresh_allocation: true, region: 'us' },
    }));
  }
  async function run(control) {
    reset();
    if (control === 'reserved-provider') row.provider = 'kernel';
    const before = clone(row);
    const dependencies = {
      getBrowserCaptchaTelemetry: async () => null,
      rotateProxy: async () => {
        if (control === 'replacement') {
          row.sessionId = 'sess_new';
          row.provider = 'kernel';
          row.status = 'PAUSED';
          return {
            provider: 'kernel',
            previousProvider: 'tilion',
            sessionId: 'sess_new',
            debugUrl: 'https://owned.invalid/view',
            wsUrl: 'ws://owned.invalid/new',
            proxySource: 'fake',
            proxyLocation: { country: 'US' },
            profileId: null,
            profileSource: 'fixture',
            proxyType: 'mobile',
            recoveryAction: 'provider_switched',
            validationBrowser: {
              close: async () => {
                closes++;
              },
            },
          };
        }
        if (control === 'reserved-provider') row.provider = 'tilion';
        const result = await native.rotateInPlace(row.id);
        assert(result);
        assert.equal(result.previousSessionId, before.sessionId);
        if (control === 'wrong-session') result.sessionId = 'sess_foreign';
        if (control === 'missing-proof') delete result.ipRotation;
        if (control === 'unproven') result.ipRotation.freshAllocation = false;
        if (control === 'context') row.contextId = 'foreign-context';
        if (control === 'missing-row') row = null;
        if (control === 'owner') row.logicalOwnerKey = 'agent:foreign';
        if (control === 'paused') row.status = 'PAUSED';
        if (control === 'user') row.controlState = 'USER';
        if (control === 'user-owner') row.context.userId = 'other-user';
        if (control === 'post-read')
          healthHook = () => {
            row.logicalOwnerKey = 'changed-after-read';
          };
        if (control === 'expired-user') {
          row.controlState = 'USER';
          row.controlLeaseExpiresAt = new Date(0);
        }
        return {
          ...result,
          proxyType: 'residential',
          recoveryAction: 'ip_rotated',
        };
      },
    };
    if (['success', 'expired-user', 'replacement'].includes(control)) {
      const result = await high.rotateBrowserProxy(
        row.id,
        'user-owned',
        undefined,
        {},
        dependencies
      );
      assert.equal(result.session_id, control === 'replacement' ? 'sess_new' : before.sessionId);
      assert.equal(result.rotations_used, 1);
      assert.equal(result.rotations_remaining, 3);
      assert.equal(result.status, 'ACTIVE');
      assert.equal(result.cookies_injected, false);
      assert.equal(restores, control === 'replacement' ? 1 : 0);
      assert.equal(closes, control === 'replacement' ? 1 : 0);
      assert.equal(connects, 0);
      if (control !== 'replacement') assert.equal(row.logicalOwnerKey, before.logicalOwnerKey);
    } else {
      await assert.rejects(
        high.rotateBrowserProxy(row.id, 'user-owned', undefined, {}, dependencies),
        /binding changed|validated transport/
      );
      assert.equal(restores, 0);
      assert.equal(connects, 0);
      assert.equal(closes, 0);
    }
    assert.equal(server.callsTo('POST', /\/rotate-ip$/).length, control === 'replacement' ? 0 : 1);
    assert.equal(server.callsTo('GET', /\/connect$/).length, 0);
    assert.equal(server.requests.length, control === 'replacement' ? 0 : 1);
    outcomes.push(control);
  }
  try {
    for (const c of [
      'success',
      'expired-user',
      'replacement',
      'wrong-session',
      'missing-proof',
      'unproven',
      'reserved-provider',
      'missing-row',
      'context',
      'owner',
      'paused',
      'user',
      'user-owner',
      'post-read',
    ])
      await run(c);
    console.log(JSON.stringify({ status: 'PASS', outcomes }));
  } finally {
    console.log(
      JSON.stringify({
        requests: server.requests.map((r) => ({
          method: r.method,
          path: r.path,
        })),
        restores,
        closes,
        connects,
      })
    );
    const ownedPort = Number(new URL(server.baseUrl).port);
    await server.stop();
    console.log(JSON.stringify({ ownedPort, listenerClosed: server.server === null }));
    Module._load = load;
  }
}
main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
