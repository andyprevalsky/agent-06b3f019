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
];
