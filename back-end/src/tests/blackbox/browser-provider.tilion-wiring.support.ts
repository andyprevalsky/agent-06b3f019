/**
 * Tilion backend wiring: default selection, kill switch, stored-row dispatch,
 * superseded release and the owned-only orphan reaper (plan criteria A1-A3, B4, B6).
 * Offline: env, prisma reads and fetch are swapped for fakes; no Tilion key needed.
 */
import nodeAssert from 'node:assert/strict';
import {
  createSessionWithContextUsingDependencies,
  getBrowserSessionHealth,
  pressSessionKeysUsingDependencies,
  uploadSessionFile,
  BrowserOperationWorkerOwnedError,
} from '../../providers/browser';
import { respondToTilionRefusal } from '../../domains/browser-session/routes.files';
import { buildBrowserSessionMetadata } from '../../domains/browser-session/service';
import { buildPreferredBrowserConfig } from '../../providers/browser/challengeRecoverySupport';
import { TilionRateLimitError } from '../../providers/browser/tilion';
import { assertTilionCarriedStateReachesReplacementsAndNever500s } from './browser-provider.tilion-carried-state.support';
import { tilionFileFetchCases } from './browser-provider.tilion-file-fetch.support';
import {
  exitGeoLocale,
  resolveExitGeoLocale,
  zoneInCountry,
} from '../../providers/browser/exitGeoLocale';
import type { Response } from 'express';
import {
  selectedBrowserProvider,
  TilionApiKeyMissingError,
  tilionEnabled,
} from '../../providers/browser/config';
import { releaseSupersededBrowser } from '../../providers/browser/sessionCleanup';
import {
  reconcileOrphanedTilionSessions,
  TILION_REAPABLE_STATUSES,
} from '../../providers/browser/tilionReaper';
import { storedBrowserProvider, type BrowserProviderSession } from '../../providers/browser/types';
import { computeGrantBrowserProvider } from '../../domains/compute-grants/config';
import { prisma } from '../../providers/database';
import { isConfirmedBrowserEnd } from '../../providers/browser/sessionPersist';
import { TilionApiError } from '../../providers/browser/tilionClient';

type Env = Record<string, string | undefined>;

async function withEnv<T>(env: Env, run: () => T | Promise<T>): Promise<T> {
  const previous: Env = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const TILION_ENV = {
  BROWSER_PROVIDER: undefined,
  BROWSER_AGENT_TILION_ENABLED: undefined,
  TILION_API_KEY: 'test-tilion-key',
};

export async function assertTilionIsTheDefaultProvider(): Promise<void> {
  await withEnv(TILION_ENV, () => {
    nodeAssert.equal(selectedBrowserProvider(), 'tilion');
    nodeAssert.equal(tilionEnabled(), true);
  });
  await withEnv({ ...TILION_ENV, BROWSER_PROVIDER: ' TILION ' }, () =>
    nodeAssert.equal(selectedBrowserProvider(), 'tilion')
  );
}

export async function assertTilionKillSwitchRoutesNewWorkToKernel(): Promise<void> {
  for (const provider of [undefined, 'tilion']) {
    for (const flag of ['false', '0', 'off', 'disabled']) {
      await withEnv(
        { ...TILION_ENV, BROWSER_PROVIDER: provider, BROWSER_AGENT_TILION_ENABLED: flag },
        () => {
          nodeAssert.equal(selectedBrowserProvider(), 'kernel', `flag ${flag}`);
          // The kill switch does not require a key: new work never reaches Tilion.
          delete process.env.TILION_API_KEY;
          nodeAssert.equal(selectedBrowserProvider(), 'kernel');
        }
      );
    }
  }
  // Explicit non-Tilion choices are unaffected by the Tilion flag.
  await withEnv({ ...TILION_ENV, BROWSER_PROVIDER: 'kernel' }, () =>
    nodeAssert.equal(selectedBrowserProvider(), 'kernel')
  );
  await withEnv(
    {
      COMPUTE_GRANT_BROWSER_PROVIDER: 'tilion',
      BROWSER_AGENT_TILION_ENABLED: 'false',
    },
    () => nodeAssert.equal(computeGrantBrowserProvider(), 'kernel')
  );
  await withEnv(
    { COMPUTE_GRANT_BROWSER_PROVIDER: 'tilion', BROWSER_AGENT_TILION_ENABLED: undefined },
    () => nodeAssert.equal(computeGrantBrowserProvider(), 'tilion')
  );
}

export async function assertTilionMissingKeyFailsLoudly(): Promise<void> {
  for (const key of [undefined, '', '   ']) {
    await withEnv({ ...TILION_ENV, TILION_API_KEY: key }, () =>
      nodeAssert.throws(() => selectedBrowserProvider(), TilionApiKeyMissingError)
    );
  }
}

export async function assertUnknownProviderFailsClosedAndTilionRowsAreRecognised(): Promise<void> {
  await withEnv({ ...TILION_ENV, BROWSER_PROVIDER: 'tillion' }, () =>
    nodeAssert.throws(() => selectedBrowserProvider(), /Unsupported BROWSER_PROVIDER/)
  );
  nodeAssert.equal(storedBrowserProvider('tilion'), 'tilion', 'tilion rows must not fall to Steel');
}

function fakeSession(provider: BrowserProviderSession['provider']): BrowserProviderSession {
  return {
    provider,
    sessionId: `${provider}-session`,
    debugUrl: 'https://live.example/view',
    taskId: 'task-1',
    wsUrl: 'wss://cdp.example/devtools',
    proxySource: 'test',
    proxyLocation: { country: 'US' },
    profileId: null,
    profileSource: 'test',
    validationBrowser: null,
  };
}

function creationDependencies(calls: string[], preferred: unknown = null) {
  const record =
    (provider: BrowserProviderSession['provider']) =>
    async (...args: unknown[]): Promise<BrowserProviderSession> => {
      calls.push(`${provider}:${JSON.stringify(args[4] ?? {})}`);
      return fakeSession(provider);
    };
  return {
    readPreferredConfig: async () => preferred,
    defaultProvider: selectedBrowserProvider,
    createKernel: record('kernel'),
    createSteel: record('steel'),
    createBrowserUse: record('browser-use'),
    createTilion: record('tilion'),
  };
}

export async function assertDefaultCreationDispatchesToTilion(): Promise<void> {
  await withEnv(TILION_ENV, async () => {
    const calls: string[] = [];
    const session = await createSessionWithContextUsingDependencies(
      'context-1',
      'agent-1',
      { country: 'US' },
      'https://example.com',
      { taskId: 'task-1', keepValidationConnection: true },
      creationDependencies(calls)
    );
    nodeAssert.equal(session.provider, 'tilion');
    nodeAssert.deepEqual(calls, ['tilion:{"keepValidationConnection":true,"taskId":"task-1"}']);
  });
  await withEnv({ ...TILION_ENV, BROWSER_AGENT_TILION_ENABLED: 'false' }, async () => {
    const calls: string[] = [];
    const session = await createSessionWithContextUsingDependencies(
      'context-1',
      'agent-1',
      { country: 'US' },
      undefined,
      { taskId: 'task-1' },
      creationDependencies(calls)
    );
    nodeAssert.equal(session.provider, 'kernel', 'kill switch must route new work to Kernel');
    nodeAssert.ok(
      calls.every((call) => !call.startsWith('tilion')),
      calls.join(',')
    );
  });
}

export async function assertStoredTilionRowDispatchesToTilion(): Promise<void> {
  const sessions = prisma.browserSession as unknown as { findUnique: unknown };
  const previousFindUnique = sessions.findUnique;
  const previousFetch = globalThis.fetch;
  const requested: string[] = [];
  sessions.findUnique = async () => ({ provider: 'tilion' });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requested.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`);
    return Response.json({
      session_id: 'sess_stored',
      state: 'ready',
      created_at: Math.floor(Date.now() / 1000) - 60,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      ttl: 3660,
    });
  }) as typeof fetch;
  try {
    // A stored Tilion row stays on Tilion even when new work is killed over to Kernel.
    await withEnv({ ...TILION_ENV, BROWSER_AGENT_TILION_ENABLED: 'false' }, async () => {
      const health = await getBrowserSessionHealth('sess_stored');
      nodeAssert.equal(health.provider, 'tilion');
      nodeAssert.equal(health.status, 'ready');
    });
    nodeAssert.deepEqual(requested, ['GET /v1/session/sess_stored/status']);

    // Agent 7a2ead9f repeatedly re-initialized a logical row whose native
    // session had disappeared. Replay the provider response at the shared
    // health boundary: confirmed absence must reach the lifecycle reconciler,
    // while authentication, outage and routing errors must still throw.
    for (const status of [404, 410, 401, 500]) {
      globalThis.fetch = async () => Response.json({ detail: 'No such session' }, { status });
      await withEnv(TILION_ENV, async () => {
        if (status === 404 || status === 410) {
          const health = await getBrowserSessionHealth('sess_stored');
          nodeAssert.equal(health.sessionId, 'sess_stored');
          nodeAssert.equal(health.provider, 'tilion');
          nodeAssert.equal(isConfirmedBrowserEnd(health.status), true);
          nodeAssert.equal(health.ttlMs, 0);
          nodeAssert.equal(health.createdAt, null);
          nodeAssert.equal(health.expiresAt, null);
        } else {
          await nodeAssert.rejects(
            getBrowserSessionHealth('sess_stored'),
            (error: unknown) => error instanceof TilionApiError && error.status === status
          );
        }
      });
    }

    const pressed: string[] = [];
    const result = await pressSessionKeysUsingDependencies('sess_stored', ['Escape'], {
      providerForSession: async () => 'tilion',
      pressKernelKeys: async () => {
        throw new Error('Kernel must not receive Tilion keys');
      },
      pressBrowserUseKeys: async () => {
        throw new Error('Browser Use must not receive Tilion keys');
      },
      pressTilionKeys: async (sessionId, keys) => {
        pressed.push(`${sessionId}:${keys.join('+')}`);
      },
    });
    nodeAssert.deepEqual(result, { provider: 'tilion', supported: true, pressed: true });
    nodeAssert.deepEqual(pressed, ['sess_stored:Escape']);
  } finally {
    sessions.findUnique = previousFindUnique;
    globalThis.fetch = previousFetch;
  }
}

export async function assertSupersededTilionReleaseIsExplicit(): Promise<void> {
  const released: string[] = [];
  const dependencies = {
    releaseKernel: async (id: string) => void released.push(`kernel:${id}`),
    releaseSteel: async (id: string) => void released.push(`steel:${id}`),
    releaseBrowserUse: async (id: string) => void released.push(`browser-use:${id}`),
    releaseTilion: async (id: string) => void released.push(`tilion:${id}`),
  };
  nodeAssert.equal(
    await releaseSupersededBrowser(
      {
        taskId: 'task-1',
        previousProvider: 'tilion',
        previousSessionId: 'sess_old',
        operation: 'rotation',
      },
      dependencies
    ),
    true
  );
  // An in-place rotate-ip / reattach keeps the session: releasing it would kill the live browser.
  nodeAssert.equal(
    await releaseSupersededBrowser(
      {
        taskId: 'task-1',
        previousProvider: 'tilion',
        previousSessionId: 'sess_same',
        currentSessionId: 'sess_same',
        operation: 'rotation',
      },
      dependencies
    ),
    true
  );
  nodeAssert.deepEqual(released, ['tilion:sess_old']);
  const exhausted = await releaseSupersededBrowser(
    {
      taskId: 'task-2',
      previousProvider: 'tilion',
      previousSessionId: 'sess_stuck',
      operation: 'resume',
    },
    {
      ...dependencies,
      releaseTilion: async () => {
        throw new Error('503 retries exhausted');
      },
    }
  );
  nodeAssert.equal(exhausted, false, 'Tilion cleanup exhaustion must be surfaced');
}

export async function assertTilionReaperReleasesOnlyOwnedTerminalSessions(): Promise<void> {
  const released: string[] = [];
  let ownedQuery: string[] = [];
  const summary = await reconcileOrphanedTilionSessions({
    apiKeyConfigured: () => true,
    // Shared account: other environments' sessions are live here too.
    listLiveSessionIds: async () => ['sess_prod_other', 'sess_ours_closed', 'sess_ours_active'],
    ownedTerminalSessionIds: async (candidates) => {
      ownedQuery = candidates;
      // A buggy owner query that returns a non-live id must still never widen the release set.
      return new Set(['sess_ours_closed', 'sess_not_live']);
    },
    release: async (id) => {
      released.push(id);
    },
  });
  nodeAssert.deepEqual(ownedQuery, ['sess_prod_other', 'sess_ours_closed', 'sess_ours_active']);
  nodeAssert.deepEqual(released, ['sess_ours_closed'], 'unowned or held sessions were released');
  nodeAssert.equal(summary.live, 3);
  nodeAssert.equal(summary.released, 1);

  const failed = await reconcileOrphanedTilionSessions({
    apiKeyConfigured: () => true,
    listLiveSessionIds: async () => ['sess_a'],
    ownedTerminalSessionIds: async () => new Set(['sess_a']),
    release: async () => {
      throw new Error('release failed');
    },
  });
  nodeAssert.equal(failed.failed, 1);

  let listed = false;
  const noKey = await reconcileOrphanedTilionSessions({
    apiKeyConfigured: () => false,
    listLiveSessionIds: async () => {
      listed = true;
      return [];
    },
  });
  nodeAssert.equal(listed, false, 'no key: the shared account is never listed');
  nodeAssert.equal(noKey.released, 0);

  // The real ownership query: provider=tilion, terminal statuses only, live ids only.
  const sessions = prisma.browserSession as unknown as { findMany: unknown };
  const previousFindMany = sessions.findMany;
  let where: unknown;
  sessions.findMany = async (args: { where: unknown }) => {
    where = args.where;
    return [{ sessionId: 'sess_ours_closed' }];
  };
  try {
    const realQuery = await reconcileOrphanedTilionSessions({
      apiKeyConfigured: () => true,
      listLiveSessionIds: async () => ['sess_ours_closed', 'sess_prod_other'],
      release: async () => undefined,
    });
    nodeAssert.equal(realQuery.released, 1);
    nodeAssert.deepEqual(where, {
      sessionId: { in: ['sess_ours_closed', 'sess_prod_other'] },
      provider: 'tilion',
      status: { in: [...TILION_REAPABLE_STATUSES] },
    });
    nodeAssert.ok(
      !(TILION_REAPABLE_STATUSES as readonly string[]).includes('ACTIVE') &&
        !(TILION_REAPABLE_STATUSES as readonly string[]).includes('PAUSED'),
      'held rows must never be reapable'
    );
  } finally {
    sessions.findMany = previousFindMany;
  }
}

export async function assertTilionUploadIsWorkerOwned(): Promise<void> {
  const sessions = prisma.browserSession as unknown as { findUnique: unknown };
  const previousFindUnique = sessions.findUnique;
  const previousFetch = globalThis.fetch;
  let providerCalls = 0;
  sessions.findUnique = async () => ({ provider: 'tilion' });
  globalThis.fetch = (async () => {
    providerCalls += 1;
    return new Response(null, { status: 500 });
  }) as typeof fetch;
  try {
    const error = await uploadSessionFile('sess_upload', Buffer.from('x'), 'a.txt').then(
      () => null,
      (rejected: unknown) => rejected
    );
    nodeAssert.ok(error instanceof BrowserOperationWorkerOwnedError, String(error));
    nodeAssert.equal(providerCalls, 0, 'a worker-owned upload must not reach Tilion');
    let status = 0;
    let body: unknown;
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      json(value: unknown) {
        body = value;
        return this;
      },
    } as unknown as Response;
    nodeAssert.equal(respondToTilionRefusal(error, res), true);
    nodeAssert.equal(status, 409);
    nodeAssert.equal((body as { error?: string }).error, 'worker_owned');
    nodeAssert.equal(respondToTilionRefusal(new Error('other'), res), false);
  } finally {
    sessions.findUnique = previousFindUnique;
    globalThis.fetch = previousFetch;
  }
}

const NO_INJECTION = {
  cookies: { injected: false, cookieCount: 0, authSource: 'none' },
  localStorage: { originCount: 0 },
  indexedDB: { originCount: 0 },
  permissions: { grantCount: 0 },
  cacheStorage: { originCount: 0 },
};

/** Benchmarks must tell a Tilion run from a silent fallback; the default's failure must surface. */
export async function assertProviderFallbackIsVisibleAndDefaultFailureSurfaces(): Promise<void> {
  const location = { country: 'US' };
  const tilionPreference = buildPreferredBrowserConfig(
    { provider: 'tilion', proxyMode: 'tilion_mobile', tilionProxyType: 'mobile' },
    location
  );
  const create = (calls: string[], failTilion: Error | null, preferred: unknown) => ({
    ...creationDependencies(calls, preferred),
    defaultProvider: () => 'kernel' as const,
    createTilion: async () => {
      calls.push('tilion');
      if (failTilion !== null) throw failTilion;
      return fakeSession('tilion');
    },
  });

  await withEnv(TILION_ENV, async () => {
    // A preference for another provider must not override the deployment selection.
    const calls: string[] = [];
    const session = await createSessionWithContextUsingDependencies(
      'context-1',
      'agent-1',
      location,
      undefined,
      { taskId: 'task-1' },
      create(calls, new Error('validation cleanup failed'), tilionPreference)
    );
    nodeAssert.equal(session.provider, 'kernel');
    nodeAssert.equal(session.providerSelection, undefined);
    nodeAssert.ok(calls.every((call) => !call.startsWith('tilion')));
    const metadata = buildBrowserSessionMetadata(session, NO_INJECTION);
    nodeAssert.equal(metadata.provider, 'kernel');
    nodeAssert.equal(metadata.requested_provider, 'kernel');
    nodeAssert.equal(metadata.provider_fallback_reason, null);

    // A run that lands on what it asked for reports no fallback.
    const direct = await createSessionWithContextUsingDependencies(
      'context-1',
      'agent-1',
      location,
      undefined,
      {},
      { ...create([], null, tilionPreference), defaultProvider: () => 'tilion' }
    );
    const directMetadata = buildBrowserSessionMetadata(direct, NO_INJECTION);
    nodeAssert.equal(directMetadata.provider, 'tilion');
    nodeAssert.equal(directMetadata.requested_provider, 'tilion');
    nodeAssert.equal(directMetadata.provider_fallback_reason, null);
  });

  // Kill switch: BROWSER_PROVIDER defaults to Tilion but new work lands on Kernel, visibly.
  await withEnv({ ...TILION_ENV, BROWSER_AGENT_TILION_ENABLED: 'false' }, async () => {
    const session = await createSessionWithContextUsingDependencies(
      'context-1',
      'agent-1',
      location,
      undefined,
      {},
      { ...creationDependencies([], tilionPreference), defaultProvider: selectedBrowserProvider }
    );
    nodeAssert.equal(session.provider, 'kernel');
    nodeAssert.equal(session.providerSelection?.requestedProvider, 'tilion');
    nodeAssert.equal(session.providerSelection?.fallbackReason, 'tilion_kill_switch');
    const noPreference = await createSessionWithContextUsingDependencies(
      'context-1',
      'agent-1',
      location,
      undefined,
      {},
      creationDependencies([])
    );
    nodeAssert.equal(noPreference.providerSelection?.fallbackReason, 'tilion_kill_switch');
  });

  // The DEFAULT provider failing is never swallowed: the typed adapter error propagates.
  await withEnv(TILION_ENV, async () => {
    const capacity = new TilionRateLimitError({
      status: 429,
      slug: 'concurrency_limit',
      message: 'concurrency limit reached',
      retryable: true,
      requestId: null,
      retryAfterMs: null,
      detail: null,
      method: 'POST',
      path: '/v1/session',
    });
    const calls: string[] = [];
    await nodeAssert.rejects(
      createSessionWithContextUsingDependencies(
        'context-1',
        'agent-1',
        location,
        undefined,
        {},
        {
          ...creationDependencies(calls),
          createTilion: async () => {
            calls.push('tilion');
            throw capacity;
          },
        }
      ),
      (error: unknown) => error === capacity
    );
    nodeAssert.deepEqual(calls, ['tilion'], 'no silent retry on another provider');
  });
}

/** Tilion reports New York/en-US for every exit; the worker gets the exit country's instead. */
export async function assertTilionExitGeoLocaleAndTargetingAreExposed(): Promise<void> {
  nodeAssert.deepEqual(exitGeoLocale('gb'), {
    country: 'GB',
    timezone: 'Europe/London',
    locale: 'en-GB',
    source: 'exit_country',
  });
  nodeAssert.equal(exitGeoLocale('UK')?.timezone, 'Europe/London');
  nodeAssert.equal(exitGeoLocale('ZZ'), null, 'unknown countries never invent a zone');
  const laUser = {
    timezone: 'America/Los_Angeles',
    initScript: 'x',
    userAgentOverride: { acceptLanguage: 'en-US,en' },
  };
  // RCA 2026-08-05: page dates follow the USER's zone. A California user exiting in the US keeps LA.
  const usExit = resolveExitGeoLocale(laUser, 'US');
  nodeAssert.equal(usExit.fingerprint, laUser, 'a consistent user fingerprint is untouched');
  nodeAssert.deepEqual(usExit.exitGeoLocale, {
    country: 'US',
    timezone: 'America/Los_Angeles',
    locale: 'en-US',
    source: 'user_fingerprint',
  });
  // A US user exiting in GB gets London: the user's zone lies in another country than the IP.
  const gbExit = resolveExitGeoLocale(laUser, 'GB');
  nodeAssert.equal(gbExit.fingerprint?.timezone, 'Europe/London');
  nodeAssert.equal(gbExit.fingerprint?.locale, 'en-GB');
  nodeAssert.equal(gbExit.exitGeoLocale?.source, 'exit_country');
  // No fingerprint: the exit country's default; unknown exit country never overrides the user.
  nodeAssert.equal(resolveExitGeoLocale(null, 'DE').exitGeoLocale?.timezone, 'Europe/Berlin');
  nodeAssert.equal(resolveExitGeoLocale(null, 'DE').fingerprint, null);
  const unknownExit = resolveExitGeoLocale(laUser, 'ZZ');
  nodeAssert.equal(unknownExit.fingerprint, laUser);
  nodeAssert.equal(unknownExit.exitGeoLocale?.source, 'user_fingerprint');
  nodeAssert.equal(resolveExitGeoLocale(null, 'ZZ').exitGeoLocale, null);
  // Backward-compatible tz aliases count as in-country.
  nodeAssert.ok(zoneInCountry('US/Pacific', 'US') && zoneInCountry('Asia/Calcutta', 'IN'));
  nodeAssert.ok(!zoneInCountry('America/Los_Angeles', 'CA'));

  const metadata = buildBrowserSessionMetadata(
    {
      ...fakeSession('tilion'),
      geoTargeting: {
        requested: 'city',
        applied: 'country',
        requestedLocation: { country: 'US', state: 'CA', city: 'San Francisco' },
        geoApplied: true,
        geoUnsupported: ['city', 'state'],
      },
    },
    NO_INJECTION
  );
  nodeAssert.deepEqual(metadata.geo_targeting, {
    requested: 'city',
    applied: 'country',
    requested_location: { country: 'US', state: 'CA', city: 'San Francisco' },
    geo_applied: true,
    geo_unsupported: ['city', 'state'],
  });
  nodeAssert.equal(
    'geo_targeting' in buildBrowserSessionMetadata(fakeSession('kernel'), NO_INJECTION),
    false
  );
}

/** Registered by browser-provider.blackbox.ts (one list keeps that file under max-lines). */
export const tilionWiringCases: Array<[string, () => Promise<void>]> = [
  ['Tilion is the default provider', assertTilionIsTheDefaultProvider],
  ['Tilion kill switch routes new work to Kernel', assertTilionKillSwitchRoutesNewWorkToKernel],
  ['Tilion selection without TILION_API_KEY fails loudly', assertTilionMissingKeyFailsLoudly],
  [
    'unknown providers fail closed and stored tilion rows stay on Tilion',
    assertUnknownProviderFailsClosedAndTilionRowsAreRecognised,
  ],
  ['default session creation dispatches to Tilion', assertDefaultCreationDispatchesToTilion],
  ['a stored Tilion row dispatches to Tilion', assertStoredTilionRowDispatchesToTilion],
  ['superseded Tilion sessions release through Tilion', assertSupersededTilionReleaseIsExplicit],
  [
    'Tilion reaper releases only owned terminal sessions',
    assertTilionReaperReleasesOnlyOwnedTerminalSessions,
  ],
  [
    'Tilion uploads are worker-owned and refused with a typed error',
    assertTilionUploadIsWorkerOwned,
  ],
  [
    'provider fallback is visible in session metadata; default failures surface typed',
    assertProviderFallbackIsVisibleAndDefaultFailureSurfaces,
  ],
  [
    'Tilion exit-country timezone/locale and geo targeting reach the worker',
    assertTilionExitGeoLocaleAndTargetingAreExposed,
  ],
  [
    'rotate-proxy/resume carry storage_state; uncarried Tilion swaps answer 409',
    assertTilionCarriedStateReachesReplacementsAndNever500s,
  ],
  ...tilionFileFetchCases,
];
