/** Offline controls: resume metadata must not wait for or reserve credentials. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

function load(path: string, modules: Record<string, unknown>) {
  const exports: Record<string, any> = {};
  const code = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, {
    exports,
    require: (name: string) => {
      if (!(name in modules)) throw new Error(`Unexpected dependency ${name}`);
      return modules[name];
    },
    console,
  });
  return exports;
}

async function main() {
  let credentialReads = 0;
  let rejectCredentials = true;
  let ttlMs = 600_000;
  let healthReads = 0;
  let session: any = {
    id: 'task',
    sessionId: 'same-session',
    status: 'ACTIVE',
    provider: 'steel',
    wsUrl: 'wss://same-session',
    debugUrl: 'debug',
    currentUrl: 'https://example.test',
    startUrl: 'https://example.test',
    logicalOwnerKey: null,
    providerProfileId: 'bound-profile',
    providerProfileSource: 'session',
    context: { userId: 'owner', contextId: 'shared-profile', providerProfiles: [] },
  };
  const calls: string[] = [];
  const credentials = async (kind: string) => {
    credentialReads++;
    calls.push(kind);
    if (rejectCredentials) throw new Error('credential store unavailable');
    return [kind];
  };
  const service = load(
    process.env.TASK_INFO_SOURCE ??
      resolve(__dirname, '../../domains/browser-session/service.task-info.ts'),
    {
      '../../providers/browser': {
        getFingerprintInjectionData: async (userId: string) => {
          calls.push(`fingerprint:${userId}`);
          return { timezone: 'UTC' };
        },
        getBrowserSessionHealth: async (id: string) => {
          assert.equal(id, 'same-session');
          healthReads++;
          return { provider: 'steel', status: 'live', ttlMs };
        },
      },
      '../../providers/logger': { createLogger: () => ({ info() {}, warn() {} }) },
      '../../providers/authRealm': { canonicalAuthRealm: () => 'example.test' },
      '../../providers/steel/sessionLifetime': { BROWSER_SESSION_MIN_REMAINING_MS: 60_000 },
      '../../providers/steel/urls': { steelPublicCdpUrl: (url: string) => url },
      '../../providers/browser/types': { storedBrowserProvider: (provider: string) => provider },
      '../../providers/browser/tilion': {},
      '../../providers/browser/exitGeoLocale': {},
      '../../providers/geoip': {},
      '../../providers/browser/sessionPersist': {},
      './repo': {
        findSessionByTaskId: async () => session,
        findUserSettings: async (id: string) => {
          calls.push(`settings:${id}`);
          return { locale: 'en' };
        },
        findPasswords: () => credentials('password'),
        reservePasskeysForRealm: () => credentials('passkey-reservation'),
      },
      './service.serializers': {
        serializePasswords: (v: unknown) => v,
        serializePasskeys: (v: unknown) => v,
        toUserSettings: (v: unknown) => v,
      },
    }
  );
  const result = await service.getTaskInfo('task', {
    includeCredentials: false,
    validateLive: true,
  });
  assert.equal(
    credentialReads,
    0,
    'metadata fetch must neither read passwords nor reserve passkeys'
  );
  assert.equal(result.session_id, 'same-session');
  assert.equal(result.browser_session_metadata.profile_id, 'bound-profile');
  assert.equal(result.fingerprint_injection.timezone, 'UTC');
  assert.equal(result.user_settings.locale, 'en');
  assert.equal(result.passwords.length + result.passkeys.length, 0);
  assert.equal(result.same_session_available, true);
  assert.equal(healthReads, 1, 'metadata-only still checks live session health');
  assert.deepEqual(calls, ['fingerprint:owner', 'settings:owner']);
  ttlMs = 0;
  assert.equal(
    (await service.getTaskInfo('task', { includeCredentials: false, validateLive: true }))
      .same_session_available,
    false
  );
  session.status = 'CLOSED';
  assert.equal(
    (await service.getTaskInfo('task', { includeCredentials: false, validateLive: true }))
      .same_session_unavailable_reason,
    'db_status_closed'
  );
  session.status = 'ACTIVE';
  await assert.rejects(
    service.getTaskInfo('task'),
    /credential store unavailable/,
    'legacy default retains credential loading'
  );
  rejectCredentials = false;
  const legacy = await service.getTaskInfo('task');
  assert.equal(legacy.passwords[0], 'password');
  assert.equal(legacy.passkeys[0], 'passkey-reservation');
  session = null;
  assert.equal(await service.getTaskInfo('missing', { includeCredentials: false }), null);
  console.log(
    'PASS metadata-only: unavailable credential store bypassed; fingerprint/profile/settings, live expiry/closed checks and legacy credential loading preserved'
  );

  let owner = 'owner';
  const forwarded: any[] = [];
  const routes: Record<string, any> = {};
  const router = {
    get: (path: string, ...handlers: any[]) => {
      routes[path] = handlers.at(-1);
    },
    post() {},
  };
  const multer = Object.assign(() => ({ single: () => () => {} }), { memoryStorage: () => ({}) });
  const modules: Record<string, unknown> = {
    express: { Router: () => router },
    multer: { default: multer },
    '../../providers/auth': {},
    '../../providers/hybridAuth': {},
    '../../providers/logger': { createLogger: () => ({ error() {} }) },
    '../../utils/asyncHandler': { asyncHandler: (fn: any) => fn },
    './service': {
      getTaskOwnerUserId: async () => owner,
      getTaskInfo: async (...args: any[]) => {
        forwarded.push(args);
        return { session_id: 'same-session' };
      },
    },
    './types': {},
  };
  for (const [file, fn] of Object.entries({
    init: 'registerBrowserInitRoute',
    credentials: 'registerBrowserCredentialRoutes',
    files: 'registerBrowserDataRoutes',
    rotation: 'registerBrowserRotationRoute',
    navigation: 'registerBrowserNavigationRoutes',
    control: 'registerBrowserControlRoutes',
    resume: 'registerBrowserResumeRoute',
    'challenge-recovery': 'registerBrowserChallengeRecoveryRoutes',
  }))
    modules[`./routes.${file}`] = { [fn]: () => {} };
  load(resolve(__dirname, '../../domains/browser-session/routes.ts'), modules);
  const request = {
    params: { taskId: 'task' },
    query: { includeCredentials: 'false', validateLive: 'true' },
    userId: 'owner',
    isInternal: false,
  };
  const response = {
    code: 200,
    status(code: number) {
      this.code = code;
      return this;
    },
    json() {},
  };
  await routes['/task/:taskId'](request, response);
  assert.equal(forwarded[0][1].includeCredentials, false);
  assert.equal(forwarded[0][1].validateLive, true);
  owner = 'other-owner';
  await routes['/task/:taskId'](request, response);
  assert.equal(response.code, 404);
  assert.equal(forwarded.length, 1, 'metadata flag must not bypass ownership');
  owner = 'owner';
  await routes['/task/:taskId']({ ...request, query: {} }, response);
  assert.equal(forwarded[1][1].includeCredentials, true, 'route default preserves legacy callers');
  console.log(
    'PASS route: explicit opt-in forwarded with validateLive; wrong owner rejected; default unchanged'
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
