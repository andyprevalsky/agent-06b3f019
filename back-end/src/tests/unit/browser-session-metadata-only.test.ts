/** Offline controls: resume metadata must not wait for or reserve credentials. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

type TaskInfoModule = typeof import('../../domains/browser-session/service.task-info');
type TaskInfoOptions = NonNullable<Parameters<TaskInfoModule['getTaskInfo']>[1]>;
type RouteRequest = {
  params: { taskId: string };
  query: Record<string, string>;
  userId: string;
  isInternal: boolean;
};
type RouteResponse = {
  code: number;
  status(code: number): RouteResponse;
  json(): void;
};
type RouteHandler = (request: RouteRequest, response: RouteResponse) => Promise<void>;

function load<T extends object>(path: string, modules: Record<string, unknown>): T {
  const exports: Partial<T> = {};
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
  return exports as T;
}

async function main() {
  let credentialReads = 0;
  let rejectCredentials = true;
  let ttlMs = 600_000;
  let healthReads = 0;
  const fixtureSession = {
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
  let session: typeof fixtureSession | null = fixtureSession;
  const calls: string[] = [];
  const credentials = async (kind: string) => {
    credentialReads++;
    calls.push(kind);
    if (rejectCredentials) throw new Error('credential store unavailable');
    return [kind];
  };
  const service = load<TaskInfoModule>(
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
      '../../providers/browser/sessionPersist': {
        isConfirmedBrowserEnd: (status: string | null) => status === 'deleted',
      },
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
  assert.ok(result);
  assert.equal(
    credentialReads,
    0,
    'metadata fetch must neither read passwords nor reserve passkeys'
  );
  assert.equal(result.session_id, 'same-session');
  assert.equal(result.browser_session_metadata.profile_id, 'bound-profile');
  assert.ok(
    typeof result.fingerprint_injection === 'object' && result.fingerprint_injection !== null
  );
  assert.ok('timezone' in result.fingerprint_injection);
  assert.equal(result.fingerprint_injection.timezone, 'UTC');
  assert.ok(result.user_settings !== null && 'locale' in result.user_settings);
  assert.equal(result.user_settings.locale, 'en');
  assert.equal(result.passwords.length + result.passkeys.length, 0);
  assert.equal(result.same_session_available, true);
  assert.equal(healthReads, 1, 'metadata-only still checks live session health');
  assert.deepEqual(calls, ['fingerprint:owner', 'settings:owner']);
  ttlMs = 0;
  const expired = await service.getTaskInfo('task', {
    includeCredentials: false,
    validateLive: true,
  });
  assert.ok(expired);
  assert.equal(expired.same_session_available, false);
  session.status = 'CLOSED';
  const closed = await service.getTaskInfo('task', {
    includeCredentials: false,
    validateLive: true,
  });
  assert.ok(closed);
  assert.equal(closed.same_session_unavailable_reason, 'db_status_closed');
  session.status = 'ACTIVE';
  await assert.rejects(
    service.getTaskInfo('task'),
    /credential store unavailable/,
    'legacy default retains credential loading'
  );
  rejectCredentials = false;
  const legacy = await service.getTaskInfo('task');
  assert.ok(legacy);
  assert.equal(legacy.passwords[0], 'password');
  assert.equal(legacy.passkeys[0], 'passkey-reservation');
  session = null;
  assert.equal(await service.getTaskInfo('missing', { includeCredentials: false }), null);
  process.stdout.write(
    'PASS metadata-only: unavailable credential store bypassed; fingerprint/profile/settings, live expiry/closed checks and legacy credential loading preserved\n'
  );

  let owner = 'owner';
  const forwarded: Array<[taskId: string, options: TaskInfoOptions]> = [];
  const routes: Record<string, RouteHandler> = {};
  const router = {
    get: (path: string, ...handlers: RouteHandler[]) => {
      const handler = handlers.at(-1);
      assert.ok(handler);
      routes[path] = handler;
    },
    post() {},
  };
  const modules: Record<string, unknown> = {
    express: { Router: () => router },
    './config': { upload: { single: () => () => {} } },
    '../../providers/auth': {},
    '../../providers/hybridAuth': {},
    '../../providers/logger': { createLogger: () => ({ error() {} }) },
    '../../utils/asyncHandler': { asyncHandler: (fn: RouteHandler) => fn },
    './service': {
      getTaskOwnerUserId: async () => owner,
      getTaskInfo: async (...args: [taskId: string, options: TaskInfoOptions]) => {
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
  process.stdout.write(
    'PASS route: explicit opt-in forwarded with validateLive; wrong owner rejected; default unchanged\n'
  );
}
main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
