/** Capture/recreate contract for profile-free private browser sessions. */
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function runBrowserPrivateRestoreCases(): Promise<void> {
  const require = createRequire(import.meta.url);
  const resumePath = new URL('../../providers/browserSessionResume.ts', import.meta.url).pathname;
  const checkpointPath = new URL('../../providers/browser/checkpoint.ts', import.meta.url).pathname;
  const indexPath = new URL('../../providers/browser/index.ts', import.meta.url).pathname;
  const pausePath = new URL('../../providers/browser/logicalPause.ts', import.meta.url).pathname;
  const loader = Module as unknown as {
    _load: (id: string, parent: { filename?: string } | undefined, isMain: boolean) => unknown;
  };
  const originalLoad = loader._load;
  const previous = [
    require.cache[resumePath],
    require.cache[checkpointPath],
    require.cache[indexPath],
    require.cache[pausePath],
  ];
  const env = {
    CLAUDE_CREDENTIAL_DECRYPTION_KEY: process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY,
    CODE_SESSION_STORAGE_BACKEND: process.env.CODE_SESSION_STORAGE_BACKEND,
    CODE_SESSION_STORAGE_LOCAL_DIR: process.env.CODE_SESSION_STORAGE_LOCAL_DIR,
  };
  const directory = await mkdtemp(join(tmpdir(), 'private-browser-restore-'));
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY = Buffer.from(
    privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  ).toString('base64');
  process.env.CODE_SESSION_STORAGE_BACKEND = 'local';
  process.env.CODE_SESSION_STORAGE_LOCAL_DIR = directory;
  const baseline = 'browser-checkpoint:empty:v1';
  const row = {
    id: 'private-task',
    logicalOwnerKey: 'agent:private-owner' as string | null,
    sessionId: 'expired-ephemeral' as string | null,
    checkpointRef: null as string | null,
    checkpointRevision: 0,
    baselineCheckpointRef: baseline,
    status: 'ACTIVE',
    provider: 'kernel',
    providerProfileId: null,
    providerProfileSource: 'challenge_candidate_ephemeral',
    controlState: 'AGENT',
    controlLeaseExpiresAt: null,
    wsUrl: 'wss://fixture.invalid',
    currentUrl: 'https://shop.example.test/checkout',
    startUrl: 'https://shop.example.test/',
    context: { userId: 'private-user' },
  };
  const authenticatedStorage = {
    cookies: [
      {
        name: 'authenticated',
        value: 'local-fixture-only',
        domain: 'shop.example.test',
        path: '/',
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ],
    origins: [
      { origin: 'https://shop.example.test', localStorage: [{ name: 'cart', value: 'held' }] },
    ],
  };
  let restored: unknown;
  let creates = 0;
  let injections = 0;
  let releases = 0;
  let captureFails = false;
  // The one native the provider reports ended ('deleted' is Tilion's 404/410 shutdown).
  let endedSessionId: string | null = null;
  let healthFails = false;
  const navigated: string[] = [];
  const frame = {
    url: () => row.currentUrl,
    evaluate: async () => null,
  };
  const page = {
    ...frame,
    evaluate: async () => [{ name: 'checkout', value: 'held' }],
    frames: () => [frame],
    context: () => browser.contexts()[0],
    route: async () => {},
    unroute: async () => {},
    close: async () => {},
    goto: async (url: string) => {
      navigated.push(url);
    },
  };
  const browser = {
    contexts: () => [
      {
        storageState: async () => {
          if (captureFails) throw new Error('fixture capture failure');
          return authenticatedStorage;
        },
        setStorageState: async (storage: unknown) => {
          restored = storage;
        },
        pages: () => [page],
        newPage: async () => page,
        newCDPSession: async () => ({
          send: async () => ({ identifier: 'fixture-script' }),
          detach: async () => {},
        }),
      },
    ],
    close: async () => {},
  };
  const database = {
    browserSession: {
      findUnique: async () => ({ ...row }),
      findUniqueOrThrow: async () => ({ ...row }),
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        if (typeof data.checkpointRef === 'string') row.checkpointRef = data.checkpointRef;
        if (data.checkpointRevision) row.checkpointRevision += 1;
        if (typeof data.status === 'string') row.status = data.status;
        return { count: 1 };
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        if (typeof data.status === 'string') row.status = data.status;
        return { ...row };
      },
    },
    browserPassword: { findMany: async () => [] },
    user: { findUnique: async () => null },
    $queryRaw: async () => [],
  };
  loader._load = function (id, parent, isMain) {
    if (id === './browser/initialization')
      return { assertBrowserInitializationReady: async () => {} };
    if (id === './browser/sessionPersist')
      return {
        isConfirmedBrowserEnd: (status: string | null) => status === 'deleted',
        recordEndedLogicalBrowser: async (_taskId: string, sessionId: string) => {
          assert.equal(sessionId, row.sessionId);
          row.status = 'PAUSED';
          return true;
        },
      };
    if (id === '../steel/lifecycleClaim' || id === './steel/lifecycleClaim')
      return {
        browserResumeScope: () => undefined,
        withSteelLifecycleClaim: async (_id: string, run: (...args: unknown[]) => unknown) =>
          run(
            async () => {},
            undefined,
            (mutate: (db: unknown) => unknown) => mutate(database)
          ),
        withBrowserResumeClaim: async (_id: string, run: (...args: unknown[]) => unknown) =>
          run(
            async () => {},
            undefined,
            (mutate: (db: unknown) => unknown) => mutate(database)
          ),
        withBrowserResumeLifecycle: async (_id: string, deps: { resume: () => unknown }) =>
          deps.resume(),
      };
    if ([resumePath, checkpointPath, indexPath].includes(parent?.filename ?? '')) {
      if (id === './database' || id === '../database') return { prisma: database };
      if (id === './logger') return { createLogger: () => ({ info() {}, warn() {}, error() {} }) };
    }
    if (parent?.filename === checkpointPath && id === '../steel/sessionConnection')
      return { connectValidatedBrowser: async () => browser };
    if (parent?.filename === indexPath) {
      if (id === './kernel')
        return {
          closeKernelSession: async (_sessionId: string, pause: boolean) => {
            assert.equal(
              pause,
              false,
              'private checkpoint replaces shared provider-profile persistence'
            );
            assert.ok(row.checkpointRef, 'state must be durably captured before release');
            releases += 1;
            row.status = 'CLOSED';
          },
        };
      // Provider dispatch reads the persisted provider through its own module.
      if (id === './sessionProvider')
        return {
          providerForSession: async () => 'kernel',
          providerForTask: async () => 'kernel',
        };
      if (id === './sessionAuthPersist')
        return {
          persistSignedInBrowserState: async () => {
            throw new Error('private pause must not publish shared auth');
          },
        };
    }
    if (parent?.filename === resumePath) {
      if (id === './steel/lifecycleClaim')
        return {
          browserResumeScope: () => undefined,
          withBrowserResumeLifecycle: async (
            _id: string,
            deps: { resume: () => Promise<unknown> }
          ) => deps.resume(),
        };
      if (id === './browser')
        return {
          getBrowserSessionHealth: async (sessionId: string) => {
            if (healthFails) throw new Error('fixture health unavailable');
            return {
              sessionId,
              status: sessionId === endedSessionId ? 'deleted' : 'live',
            };
          },
          resumeSession: async (_id: string, options: { forceFreshProfile: boolean }) => {
            creates += 1;
            if (row.logicalOwnerKey) assert.equal(options.forceFreshProfile, true);
            row.sessionId = `replacement-${creates}`;
            row.status = row.logicalOwnerKey ? 'PAUSED' : 'ACTIVE';
            return {
              provider: 'kernel',
              sessionId: row.sessionId,
              savedUrl: row.currentUrl,
              wsUrl: row.wsUrl,
              debugUrl: 'https://fixture.invalid',
              profileId: 'unrelated-persistent-profile',
              profileSource: 'user_persistent',
              validationBrowser: browser,
            };
          },
          getFingerprintInjectionData: async () => null,
          injectUserData: async () => {
            injections += 1;
            return { cookies: { injected: false }, fingerprint: { injected: false } };
          },
        };
    }
    return originalLoad.call(this, id, parent, isMain);
  };
  try {
    delete require.cache[resumePath];
    delete require.cache[checkpointPath];
    delete require.cache[indexPath];
    delete require.cache[pausePath];
    const { resumeBrowserSession } = require(
      resumePath
    ) as typeof import('../../providers/browserSessionResume');
    const { closeSession } = require(indexPath) as typeof import('../../providers/browser');
    // A first materialization has no source; its empty baseline is valid.
    row.sessionId = null;
    await resumeBrowserSession(row.id);
    assert.deepEqual(restored, { cookies: [], origins: [] });
    assert.throws(() => assert.deepEqual(restored, authenticatedStorage));
    console.log('OBSERVED empty first materialization differs from authenticated checkout');
    row.status = 'PAUSED';
    await assert.rejects(resumeBrowserSession(row.id), /saved checkpoint is missing/);
    assert.equal(creates, 1, 'missing source checkpoint must not allocate another browser');

    // The provider ended the source before any pause (Tilion CDP 1012, connect
    // 410 shutdown): its state cannot be captured, so resume restores the last
    // durable checkpoint (the baseline) with exactly one replacement, whether the
    // ended source is first seen ACTIVE or was already recorded PAUSED.
    for (const sourceStatus of ['ACTIVE', 'PAUSED']) {
      const replacementsBefore = creates;
      row.status = sourceStatus;
      restored = undefined;
      endedSessionId = row.sessionId;
      const resumed = await resumeBrowserSession(row.id);
      endedSessionId = null;
      assert.deepEqual(restored, { cookies: [], origins: [] }, `${sourceStatus} provider-ended`);
      assert.deepEqual(
        (resumed as { provider_session_lost?: unknown }).provider_session_lost,
        { restored_checkpoint_revision: 0 },
        'a provider-ended restore reports the lost state, never silently'
      );
      assert.equal(creates, replacementsBefore + 1, `${sourceStatus} provider-ended replacement`);
      assert.equal(row.checkpointRef, null, 'restore from the baseline publishes no checkpoint');
    }
    row.status = 'PAUSED';
    await assert.rejects(resumeBrowserSession(row.id), /saved checkpoint is missing/);
    assert.equal(creates, 3, 'a live replacement without its checkpoint still refuses');
    healthFails = true;
    await assert.rejects(resumeBrowserSession(row.id), /fixture health unavailable/);
    healthFails = false;
    assert.equal(creates, 3, 'unknown provider health never accepts the state loss');
    row.status = 'ACTIVE';

    // The existing pause capture supplies the state needed by the exact same resume path.
    captureFails = true;
    await assert.rejects(closeSession(row.sessionId!, true), /fixture capture failure/);
    assert.equal(releases, 0, 'failed capture must keep the provider browser alive');
    assert.equal(row.checkpointRef, null);
    captureFails = false;
    navigated.length = 0;
    await closeSession(row.sessionId!, true);
    assert.equal(row.checkpointRevision, 1);
    assert.equal(row.status, 'PAUSED');
    assert.equal(releases, 1);
    const checkpointed = await resumeBrowserSession(row.id);
    assert.equal(
      (checkpointed as { provider_session_lost?: unknown }).provider_session_lost,
      undefined,
      'a checkpointed resume lost nothing'
    );
    assert.deepEqual(
      restored,
      authenticatedStorage,
      'private auth and cart survive provider replacement'
    );
    assert.deepEqual(
      navigated.filter((url) => !url.includes('/.rose-')),
      [row.currentUrl]
    );
    assert.equal(injections, 0, 'private restore must not inject shared credentials');

    row.sessionId = null;
    row.checkpointRef = null;
    row.checkpointRevision = 0;
    row.status = 'PAUSED';
    await resumeBrowserSession(row.id);
    assert.deepEqual(
      restored,
      { cookies: [], origins: [] },
      'first materialization retains empty-baseline support'
    );

    row.logicalOwnerKey = null;
    await resumeBrowserSession(row.id);
    assert.equal(injections, 1, 'legacy nonlogical credential injection remains supported');
    console.log(
      'PASS private browser pause/restore (missing-capture control; provider-ended source restores last durable checkpoint; capture failure retains provider; encrypted auth/cart roundtrip; first materialization; legacy)'
    );
  } finally {
    loader._load = originalLoad;
    delete require.cache[resumePath];
    delete require.cache[checkpointPath];
    delete require.cache[indexPath];
    delete require.cache[pausePath];
    if (previous[0]) require.cache[resumePath] = previous[0];
    if (previous[1]) require.cache[checkpointPath] = previous[1];
    if (previous[2]) require.cache[indexPath] = previous[2];
    if (previous[3]) require.cache[pausePath] = previous[3];
    await rm(directory, { recursive: true, force: true });
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
