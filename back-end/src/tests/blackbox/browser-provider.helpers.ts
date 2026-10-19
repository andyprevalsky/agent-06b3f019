import nodeAssert from 'node:assert';
import { chromium, type Browser, type Page } from 'playwright';
import { prisma } from '../../providers/database';
import { recreateSession } from '../../providers/steel/sessionResume';
import { rotateProxy } from '../../providers/browser';
import { steel } from '../../providers/steel/session';
import { steelEnvironmentIdentity } from '../../providers/steel/sessionIdentity';
import { APIConnectionTimeoutError } from '@onkernel/sdk';
import {
  isKernelProxyAvailabilityError,
  KERNEL_CREATE_REQUEST_OPTIONS,
} from '../../providers/browser/kernelProxy';
import { retryWithBackoff } from '../../providers/retry';
import { browserUseEnabled } from '../../providers/browser/config';
import { readBrowserUseSessionFile } from '../../providers/browser/browserUse';
import { computeGrantBrowserProvider } from '../../domains/compute-grants/config';
import { storedBrowserProvider } from '../../providers/browser/types';

export function assertBrowserUseRolloutOptIn(): void {
  const previous = process.env.BROWSER_AGENT_BROWSER_USE_ENABLED;
  const previousCompute = process.env.COMPUTE_GRANT_BROWSER_PROVIDER;
  process.env.COMPUTE_GRANT_BROWSER_PROVIDER = 'browser-use';
  try {
    for (const value of ['', 'unexpected', 'false']) {
      process.env.BROWSER_AGENT_BROWSER_USE_ENABLED = value;
      assert(!browserUseEnabled(), `Browser Use unexpectedly enabled for ${JSON.stringify(value)}`);
      assert(
        computeGrantBrowserProvider() === 'kernel',
        `compute grants unexpectedly selected Browser Use for ${JSON.stringify(value)}`
      );
    }
    process.env.BROWSER_AGENT_BROWSER_USE_ENABLED = ' YES ';
    assert(browserUseEnabled(), 'explicit yes did not enable Browser Use');
    assert(computeGrantBrowserProvider() === 'browser-use', 'compute grants rejected yes');
  } finally {
    if (previous === undefined) delete process.env.BROWSER_AGENT_BROWSER_USE_ENABLED;
    else process.env.BROWSER_AGENT_BROWSER_USE_ENABLED = previous;
    if (previousCompute === undefined) delete process.env.COMPUTE_GRANT_BROWSER_PROVIDER;
    else process.env.COMPUTE_GRANT_BROWSER_PROVIDER = previousCompute;
  }
}

export function assertStoredProviderFallback(): void {
  assert(storedBrowserProvider('kernel') === 'kernel', 'Kernel routing changed');
  assert(storedBrowserProvider('browser-use') === 'browser-use', 'Browser Use routing changed');
  assert(storedBrowserProvider('legacy') === 'steel', 'legacy browser row must use Steel');
}

/**
 * A signed download URL that accepts the connection and never answers must be
 * aborted by a bounded signal instead of pinning the session file read forever.
 * `AbortSignal.timeout` is swapped for a controller the test fires, so the
 * deadline elapses instantly without waiting out the real bound.
 */
export async function assertBrowserUseDownloadFetchIsBounded(): Promise<void> {
  const previousFetch = globalThis.fetch;
  const previousTimeout = AbortSignal.timeout;
  const previousKey = process.env.BROWSER_USE_API_KEY;
  const deadline = new AbortController();
  const requestedTimeouts: number[] = [];
  let downloadSignal: AbortSignal | undefined;
  let markDownloadStarted = () => {};
  const downloadStarted = new Promise<void>((resolve) => {
    markDownloadStarted = resolve;
  });
  process.env.BROWSER_USE_API_KEY = 'test-browser-use-key';
  AbortSignal.timeout = (ms: number) => {
    requestedTimeouts.push(ms);
    return deadline.signal;
  };
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname !== 'download.example') {
      return Response.json({
        files: [
          {
            path: 'stalled.pdf',
            size: 1,
            lastModified: '2026-10-01T00:00:00Z',
            url: 'https://download.example/stalled.pdf',
          },
        ],
        hasMore: false,
        nextCursor: null,
      });
    }
    downloadSignal = init?.signal ?? undefined;
    markDownloadStarted();
    const signal = init?.signal;
    if (!signal) throw new Error('signed download fetch has no abort signal');
    return new Promise<Response>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }) as typeof fetch;
  try {
    const outcome = readBrowserUseSessionFile('browser-use-session', 'stalled.pdf').then(
      () => new Error('stalled download unexpectedly resolved'),
      (error: unknown) => error
    );
    await Promise.race([downloadStarted, outcome]);
    deadline.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    const error = await outcome;
    assert(
      error instanceof Error && error.name === 'TimeoutError',
      `stalled Browser Use download was not aborted: ${String(error)}`
    );
    assert(downloadSignal === deadline.signal, 'download fetch ignored the bounded signal');
    assert(
      requestedTimeouts.length === 1 &&
        requestedTimeouts[0] > 0 &&
        requestedTimeouts[0] <= 5 * 60_000,
      `download fetch deadline is not a bounded timeout: ${JSON.stringify(requestedTimeouts)}`
    );
  } finally {
    globalThis.fetch = previousFetch;
    AbortSignal.timeout = previousTimeout;
    if (previousKey === undefined) delete process.env.BROWSER_USE_API_KEY;
    else process.env.BROWSER_USE_API_KEY = previousKey;
  }
}

export function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

export function assertKernelCityInventoryFallback(): void {
  const error = new Error(
    "400 proxy configuration validation failed: city 'sanfrancisco' is not available for subdivision 'us-ca'"
  );
  assert(isKernelProxyAvailabilityError(error), 'expected proxy availability error');
}

export function assertKernelTimeoutFallback(): void {
  assert(
    isKernelProxyAvailabilityError(new APIConnectionTimeoutError()),
    'APIConnectionTimeoutError must relax city→state→country'
  );
  assert(
    isKernelProxyAvailabilityError(new Error('Request timed out.')),
    'string timeout must also relax location specificity'
  );
  assert(
    KERNEL_CREATE_REQUEST_OPTIONS.maxRetries === 0 &&
      KERNEL_CREATE_REQUEST_OPTIONS.timeout === 45_000,
    'create calls must fail fast (no SDK retry multiplication into ~180s)'
  );
}

export function isTransientKernelConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? error.cause : undefined;
  const causeText =
    cause instanceof Error
      ? `${cause.message} ${cause.name}`
      : cause !== null && typeof cause === 'object'
        ? `${String((cause as { message?: unknown }).message ?? '')} ${String(
            (cause as { code?: unknown }).code ?? ''
          )}`
        : String(cause ?? '');
  const transportError = `${message} ${causeText}`;
  return (
    message.includes('proxy connection failed') ||
    message.includes('context deadline exceeded') ||
    message.includes('Client.Timeout exceeded') ||
    // Steel create/replace flakes under parallel coverage load (SDK "Connection error").
    message.includes('Failed to create Steel replacement') ||
    message.includes('Connection error') ||
    // Coverage blackbox shares a 4-connection Prisma pool; live rotate-proxy
    // can 500 with P2024 while another domain holds the pool.
    message.includes('Timed out fetching a new connection from the connection pool') ||
    message.includes('P2024') ||
    transportError.includes('fetch failed') ||
    transportError.includes('other side closed') ||
    transportError.includes('socket hang up') ||
    transportError.includes('ECONNRESET') ||
    transportError.includes('ECONNREFUSED') ||
    transportError.includes('UND_ERR')
  );
}

/** Retry localhost transport resets without weakening HTTP response assertions. */
export function retryBackendFetch(url: string, init?: RequestInit): Promise<Response> {
  return retryWithBackoff(() => fetch(url, init), {
    maxRetries: 4,
    fixedDelays: [250, 500, 750],
    isRetryable: isTransientKernelConnectionError,
    component: 'browser-provider:backend-fetch',
  });
}

export function isRetryableKernelNavigationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return [
    'net::ERR_CONNECTION_CLOSED',
    'net::ERR_PROXY_CONNECTION_FAILED',
    'net::ERR_TUNNEL_CONNECTION_FAILED',
    'Timeout 30000ms exceeded',
  ].some((fragment) => message.includes(fragment));
}

/** A residential exit can answer with its own gateway error page instead of failing the socket. */
export function isRetryableKernelGatewayStatus(status: number | null): boolean {
  return status !== null && status >= 502 && status <= 504;
}

/** Navigate through a transient proxy failure; returns the final HTTP status. */
export async function navigateKernelPage(page: Page, url: string): Promise<number | null> {
  for (let attempt = 1; ; attempt++) {
    let status: number | null;
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      status = response?.status() ?? null;
    } catch (error) {
      if (attempt === 3 || !isRetryableKernelNavigationError(error)) throw error;
      await page.waitForTimeout(attempt * 1_000);
      continue;
    }
    if (attempt === 3 || !isRetryableKernelGatewayStatus(status)) return status;
    await page.waitForTimeout(attempt * 1_000);
  }
}

export interface BrowserMetadataResponse {
  provider?: string;
  proxy_source?: string;
  proxy_location?: { country?: string; state?: string; city?: string };
  profile_id?: string;
  steel_profile_id?: string;
}

export interface BrowserApiResponse {
  session_id?: string;
  task_id?: string;
  debug_url?: string;
  ws_url?: string;
  saved_url?: string;
  provider?: string;
  path?: string;
  base64_image?: string;
  same_session_available?: boolean;
  resized?: boolean;
  viewport?: { width?: number; height?: number };
  browser_session_metadata?: BrowserMetadataResponse;
  // rotate_ip response fields
  proxy_tier?: string;
  rotations_used?: number;
  rotations_remaining?: number;
  rotation_message?: string;
  previous_provider?: string;
  recovery_action?: string;
  next_recovery?: string;
}

export function withProvider(value: string | undefined, test: () => void): void {
  const previous = process.env.BROWSER_PROVIDER;
  if (value === undefined) delete process.env.BROWSER_PROVIDER;
  else process.env.BROWSER_PROVIDER = value;
  try {
    test();
  } finally {
    if (previous === undefined) delete process.env.BROWSER_PROVIDER;
    else process.env.BROWSER_PROVIDER = previous;
  }
}

/** Exercise actual Steel replacement/facade with offline native and DB boundaries. */
export async function assertSteelSameProfileReplacement(retryReleased: boolean): Promise<void> {
  await assertSteelSameProfileReplacementState(retryReleased, true);
  if (retryReleased) await assertSteelSameProfileReplacementState(true, false);
}

async function assertSteelSameProfileReplacementState(
  retryReleased: boolean,
  inspectReleased: boolean
): Promise<void> {
  const originals = {
    find: prisma.browserSession.findUnique,
    fingerprint: prisma.integration.findUnique,
    update: prisma.browserSession.updateMany,
    remember: prisma.browserProviderProfile.upsert,
    contextUpdate: prisma.browserContext.update,
    create: steel.sessions.create,
    inspect: steel.sessions.retrieve,
    release: steel.sessions.release,
    get: steel.get,
    connect: chromium.connectOverCDP,
    query: prisma.$queryRaw,
    transaction: prisma.$transaction,
    intentCreate: prisma.toolSideEffect.create,
    effectFind: prisma.toolSideEffect.findUnique,
    effectUpsert: prisma.toolSideEffect.upsert,
    execute: prisma.$executeRaw,
    effectList: prisma.toolSideEffect.findMany,
    effectUpdate: prisma.toolSideEffect.updateMany,
    fetch: globalThis.fetch,
    workspace: process.env.CONDUCTOR_WORKSPACE_NAME,
  };
  const row = {
    id: 'offline-task',
    sessionId: 'offline-source',
    provider: 'steel',
    providerProfileId: 'offline-profile',
    providerProfileSource: 'session_bound',
    providerProfilePersist: true,
    contextId: 'offline-context',
    agentId: null,
    currentUrl: null,
    startUrl: null,
    proxyRotationCount: 4,
    status: 'ACTIVE',
    closedAt: null as Date | null,
    context: { userId: 'offline-user' },
  };
  type Effect = {
    operationKey: string;
    operationType: string;
    status: string;
    externalId: string;
    request: Record<string, unknown>;
    updatedAt?: Date;
  };
  const claims = new Map<string, Effect>();
  const candidates = new Map<string, Effect>();
  const leases = new Map<string, Effect>();
  const claimOwners: string[] = [];
  const releasedOwners: string[] = [];
  const inspectedSourceStates: string[] = [];
  const allocated = new Set<string>();
  const requested = new Set<string>();
  let ready = false;
  let profileReads = 0;
  let releases = 0;
  let failCreate = retryReleased;
  let createAttempts = 0;
  let replacementId = '';
  let externalCalls = 0;
  const matches = (effect: Effect, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, expected]) => {
      if (key === 'request' && typeof expected === 'object' && expected !== null) {
        const filter = expected as { path: string[]; equals: unknown };
        return (
          filter.path.reduce<unknown>(
            (value, part) => (value as Record<string, unknown>)[part],
            effect.request
          ) === filter.equals
        );
      }
      const actual = effect[key as keyof Effect];
      if (typeof expected === 'object' && expected !== null && 'gt' in expected) {
        return (
          expected.gt instanceof Date &&
          actual instanceof Date &&
          actual.getTime() > expected.gt.getTime()
        );
      }
      return actual === expected;
    });
  try {
    process.env.CONDUCTOR_WORKSPACE_NAME = `offline-steel-same-profile-${retryReleased}-${inspectReleased}`;
    globalThis.fetch = (async () => {
      externalCalls++;
      throw new Error('unexpected external request in same-profile fixture');
    }) as typeof fetch;
    prisma.$transaction = (async (callback: (tx: typeof prisma) => Promise<unknown>) =>
      callback(prisma)) as typeof originals.transaction;
    prisma.$executeRaw = (async () => 0) as typeof originals.execute;
    prisma.$queryRaw = (async (
      query: { strings: string[]; values: unknown[] } | TemplateStringsArray
    ) => {
      if (Array.isArray(query)) {
        nodeAssert.strictEqual(query.join(''), 'SELECT clock_timestamp() AS now');
        return [{ now: new Date() }];
      }
      const sql = query as { strings: string[]; values: unknown[] };
      if (sql.strings[0].includes('SELECT')) {
        nodeAssert(sql.strings.join('').includes('FOR UPDATE'), 'missing atomic claim row lock');
        const effect = claims.get(String(sql.values[0]));
        return effect ? [{ ...effect, request: { ...effect.request } }] : [];
      }
      const key = String(sql.values[1]);
      nodeAssert(
        [
          'steel-browser-task-lifecycle:offline-task',
          'steel-browser-task-lifecycle:profile:offline-profile',
        ].includes(key)
      );
      const now = sql.values[5] as Date;
      const previous = claims.get(key);
      if (
        previous?.status === 'STARTED' &&
        (Date.parse(String(previous.request.expiresAt)) > now.getTime() ||
          previous.request.nativeOutstanding === true)
      )
        return [];
      const owner = String(sql.values[3]);
      const request = JSON.parse(String(sql.values[4]));
      nodeAssert.strictEqual(sql.values[2], 'steel_browser_task_lifecycle');
      claimOwners.push(`${key}:${owner}`);
      claims.set(key, {
        operationKey: key,
        operationType: 'steel_browser_task_lifecycle',
        status: 'STARTED',
        externalId: owner,
        request,
        updatedAt: now,
      });
      return [{ externalId: owner }];
    }) as typeof originals.query;
    prisma.toolSideEffect.create = (async ({ data }: { data: Effect }) => {
      nodeAssert.strictEqual(data.operationType, 'steel_candidate_cleanup');
      nodeAssert.strictEqual(data.status, 'PENDING');
      nodeAssert.strictEqual(data.request.taskId, row.id);
      nodeAssert.strictEqual(data.request.profileId, row.providerProfileId);
      nodeAssert.strictEqual(data.request.ownershipIdentity, steelEnvironmentIdentity());
      nodeAssert(!candidates.has(data.operationKey), 'duplicate candidate custody');
      candidates.set(data.operationKey, data);
      return data;
    }) as typeof originals.intentCreate;
    prisma.toolSideEffect.upsert = (async (args: {
      where: { operationKey: string };
      create: Effect;
      update: Partial<Effect>;
    }) => {
      const existing = leases.get(args.where.operationKey);
      const next = existing ? { ...existing, ...args.update } : { ...args.create };
      nodeAssert(next.updatedAt instanceof Date, 'lease must retain database timestamp');
      nodeAssert(typeof next.request.leaseMs === 'number', 'lease duration missing from request');
      leases.set(args.where.operationKey, next);
      return next;
    }) as typeof originals.effectUpsert;
    prisma.toolSideEffect.findUnique = (async ({ where }: { where: { operationKey: string } }) =>
      claims.get(where.operationKey) ??
      candidates.get(where.operationKey) ??
      leases.get(where.operationKey) ??
      null) as typeof originals.effectFind;
    prisma.toolSideEffect.findMany = (async () =>
      [...candidates.values()].filter(
        (candidate) => candidate.status === 'PENDING'
      )) as typeof originals.effectList;
    prisma.toolSideEffect.updateMany = (async (args: {
      where: Record<string, unknown>;
      data: Partial<Effect>;
    }) => {
      const table =
        args.where.operationType === 'steel_candidate_cleanup'
          ? candidates
          : leases.has(String(args.where.operationKey))
            ? leases
            : claims;
      const effect = table.get(String(args.where.operationKey));
      if (!effect || !matches(effect, args.where)) return { count: 0 };
      if (table === claims && args.data.status === 'RELEASED') {
        nodeAssert.strictEqual(effect.status, 'STARTED');
        nodeAssert.strictEqual(args.where.externalId, effect.externalId);
        releasedOwners.push(`${effect.operationKey}:${effect.externalId}`);
      }
      Object.assign(effect, args.data);
      return { count: 1 };
    }) as typeof originals.effectUpdate;
    prisma.browserSession.findUnique = (async (args: { select?: object }) =>
      'agentId' in (args.select ?? {}) ? null : { ...row }) as typeof originals.find;
    prisma.integration.findUnique = (async () => null) as typeof originals.fingerprint;
    prisma.browserSession.updateMany = (async (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      if (
        Object.entries(args.where).some(
          ([key, expected]) => row[key as keyof typeof row] !== expected
        )
      )
        return { count: 0 };
      Object.assign(row, args.data);
      return { count: 1 };
    }) as typeof originals.update;
    prisma.browserProviderProfile.upsert = (async () => ({})) as typeof originals.remember;
    prisma.browserContext.update = (async () => ({})) as typeof originals.contextUpdate;
    steel.sessions.retrieve = (async (id: string) => {
      nodeAssert.strictEqual(id, 'offline-source', 'unexpected foreign/native inspection');
      const status = ready && inspectReleased ? 'released' : 'live';
      inspectedSourceStates.push(status);
      return { id, profileId: 'offline-profile', persistProfile: true, status };
    }) as typeof originals.inspect;
    steel.sessions.release = (async (id: string) => {
      nodeAssert.strictEqual(id, 'offline-source', 'released unallocated/foreign candidate');
      nodeAssert.strictEqual(row.status, 'PAUSED', 'source release must retain recovery custody');
      if (inspectReleased)
        nodeAssert(!ready, 'exact released proof forbids a duplicate native release');
      releases++;
      if (ready) throw Object.assign(new Error('already released'), { status: 404 });
      ready = true;
      return {};
    }) as typeof originals.release;
    steel.get = (async (path: string) => {
      nodeAssert.strictEqual(path, '/v1/profiles/offline-profile');
      nodeAssert(ready, 'profile readiness must follow acknowledged source release');
      nodeAssert.strictEqual(row.status, 'PAUSED', 'readiness must retain recovery custody');
      profileReads++;
      return { status: 'READY' };
    }) as typeof originals.get;
    steel.sessions.create = (async (input: {
      sessionId: string;
      profileId?: string;
      persistProfile?: boolean;
      sessionContext?: unknown;
    }) => {
      createAttempts++;
      nodeAssert(ready, 'same-profile attach preceded source release');
      nodeAssert(profileReads > 0, 'replacement create requires native profile readiness');
      nodeAssert.strictEqual(row.status, 'PAUSED');
      nodeAssert.strictEqual(row.closedAt, null);
      nodeAssert.strictEqual(input.profileId, 'offline-profile');
      nodeAssert.strictEqual(input.persistProfile, true, 'full profile persistence was dropped');
      nodeAssert.strictEqual(
        input.sessionContext,
        undefined,
        'context substituted for full profile'
      );
      const intent = candidates.get(`steel-candidate-cleanup:${input.sessionId}`);
      nodeAssert.strictEqual(intent?.status, 'PENDING', 'native create preceded durable custody');
      nodeAssert.strictEqual(intent?.externalId, input.sessionId);
      nodeAssert(!requested.has(input.sessionId), 'a requested UUID was reused');
      requested.add(input.sessionId);
      if (failCreate) throw Object.assign(new Error('offline create failed'), { status: 429 });
      allocated.add(input.sessionId);
      replacementId = input.sessionId;
      return {
        id: input.sessionId,
        debugUrl: 'https://offline.invalid',
        profileId: 'offline-profile',
      };
    }) as typeof originals.create;
    chromium.connectOverCDP = (async () =>
      ({
        contexts: () => [{ pages: () => [{}] }],
        close: async () => {},
      }) as unknown as Browser) as typeof originals.connect;
    if (retryReleased) {
      await nodeAssert.rejects(
        () => recreateSession('offline-task', { forceManagedRotation: true }),
        /offline create failed/
      );
      nodeAssert.strictEqual(createAttempts, 1, 'HTTP429 must preserve immediate rate-limit exit');
      nodeAssert.strictEqual(row.status, 'PAUSED');
      nodeAssert.strictEqual(row.closedAt, null);
      nodeAssert.strictEqual(row.sessionId, 'offline-source');
      nodeAssert.strictEqual(row.providerProfileId, 'offline-profile');
      nodeAssert(
        [...candidates.values()].every((candidate) => candidate.status === 'RELEASED'),
        'definite rejected creates retained unresolved candidate custody'
      );
      failCreate = false;
      const recovered = await recreateSession('offline-task', { forceManagedRotation: true });
      nodeAssert.strictEqual(recovered.previousSessionReleased, true);
      if (inspectReleased) {
        // The second exact native inspection proves released; no release404 is required.
        nodeAssert.deepStrictEqual(inspectedSourceStates, ['live', 'released']);
        nodeAssert.strictEqual(releases, 1, 'already released writer was released again');
      } else {
        // Stale/live inspection cannot prove release; retain the SDK's idempotent 404 path.
        nodeAssert.deepStrictEqual(inspectedSourceStates, ['live', 'live']);
        nodeAssert.strictEqual(
          releases,
          2,
          'second invocation must use the existing idempotent release404 contract'
        );
      }
    } else {
      const result = await rotateProxy('offline-task', {
        provider: 'steel',
        proxyType: 'residential',
        recoveryAction: 'ip_rotated',
      });
      nodeAssert.strictEqual(result.sessionId, replacementId);
      nodeAssert.strictEqual(releases, 1, 'facade released the source a second time');
    }
    nodeAssert.strictEqual(row.status, 'ACTIVE');
    nodeAssert.strictEqual(row.sessionId, replacementId);
    nodeAssert.strictEqual(row.providerProfileId, 'offline-profile');
    nodeAssert.strictEqual(row.providerProfilePersist, true);
    nodeAssert.strictEqual(allocated.size, 1);
    nodeAssert.strictEqual(
      candidates.get(`steel-candidate-cleanup:${replacementId}`)?.status,
      'COMMITTED'
    );
    nodeAssert(![...candidates.values()].some((candidate) => candidate.status === 'PENDING'));
    nodeAssert.strictEqual(claimOwners.length, retryReleased ? 4 : 2, 'task/profile claim missing');
    nodeAssert.deepStrictEqual(
      releasedOwners.slice().sort(),
      claimOwners.slice().sort(),
      'claim release lost exact task/profile owner identity'
    );
    nodeAssert([...claims.values()].every((claim) => claim.status === 'RELEASED'));
  } finally {
    prisma.browserSession.findUnique = originals.find;
    prisma.integration.findUnique = originals.fingerprint;
    prisma.browserSession.updateMany = originals.update;
    prisma.browserProviderProfile.upsert = originals.remember;
    prisma.browserContext.update = originals.contextUpdate;
    steel.sessions.create = originals.create;
    steel.sessions.retrieve = originals.inspect;
    steel.sessions.release = originals.release;
    steel.get = originals.get;
    chromium.connectOverCDP = originals.connect;
    prisma.$queryRaw = originals.query;
    prisma.$transaction = originals.transaction;
    prisma.toolSideEffect.create = originals.intentCreate;
    prisma.toolSideEffect.findUnique = originals.effectFind;
    prisma.toolSideEffect.upsert = originals.effectUpsert;
    prisma.$executeRaw = originals.execute;
    prisma.toolSideEffect.findMany = originals.effectList;
    prisma.toolSideEffect.updateMany = originals.effectUpdate;
    globalThis.fetch = originals.fetch;
    if (originals.workspace === undefined) delete process.env.CONDUCTOR_WORKSPACE_NAME;
    else process.env.CONDUCTOR_WORKSPACE_NAME = originals.workspace;
    nodeAssert.strictEqual(externalCalls, 0, 'unexpected external call was swallowed');
  }
}
