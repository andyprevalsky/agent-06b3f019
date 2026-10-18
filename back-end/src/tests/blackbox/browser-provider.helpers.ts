import nodeAssert from 'node:assert';
import { chromium, type Browser, type Page } from 'playwright';
import { prisma } from '../../providers/database';
import { recreateSession } from '../../providers/steel/sessionResume';
import { rotateProxy } from '../../providers/browser';
import { steel } from '../../providers/steel/session';
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
  const find = prisma.browserSession.findUnique;
  const fingerprint = prisma.integration.findUnique;
  const update = prisma.browserSession.updateMany;
  const remember = prisma.browserProviderProfile.upsert;
  const contextUpdate = prisma.browserContext.update;
  const create = steel.sessions.create;
  const release = steel.sessions.release;
  const get = steel.get;
  const connect = chromium.connectOverCDP;
  const transaction = prisma.$transaction;
  const leaseUpdate = prisma.toolSideEffect.updateMany;
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
    closedAt: null,
    context: { userId: 'offline-user' },
  };
  let ready = false;
  let profileReads = 0;
  let releases = 0;
  let failCreate = retryReleased;
  let leaseRow: {
    operationKey: string;
    operationType: string;
    status: string;
    externalId: string;
    updatedAt: Date;
    request: { leaseMs: number; renewedAt?: string };
  } | null = null;
  let leaseReleases = 0;
  prisma.$transaction = (async (callback: (tx: unknown) => Promise<unknown>) =>
    callback({
      $executeRaw: async () => 0,
      $queryRaw: async (query: TemplateStringsArray) => {
        nodeAssert.strictEqual(query.join(''), 'SELECT clock_timestamp() AS now');
        return [{ now: new Date() }];
      },
      toolSideEffect: {
        findUnique: async () => leaseRow,
        upsert: async (args: { create: NonNullable<typeof leaseRow> }) => {
          leaseRow = { ...args.create };
          return leaseRow;
        },
        updateMany: (...args: Parameters<typeof leaseUpdate>) =>
          prisma.toolSideEffect.updateMany(...args),
      },
    })) as typeof transaction;
  prisma.toolSideEffect.updateMany = (async (args: {
    where: Record<string, unknown>;
    data: {
      status?: string;
      updatedAt?: Date;
      request?: { leaseMs: number; renewedAt?: string };
      response?: unknown;
    };
  }) => {
    if (
      leaseRow === null ||
      Object.entries(args.where).some(([key, value]) => {
        const actual = leaseRow?.[key as keyof typeof leaseRow];
        if (value && typeof value === 'object' && 'gt' in value) {
          return !(
            value.gt instanceof Date &&
            actual instanceof Date &&
            actual.getTime() > value.gt.getTime()
          );
        }
        return actual !== value;
      })
    ) {
      return { count: 0 };
    }
    if (args.data.status === 'RELEASED') leaseReleases++;
    Object.assign(leaseRow, args.data);
    return { count: 1 };
  }) as unknown as typeof leaseUpdate;
  prisma.browserSession.findUnique = (async (args: unknown) => {
    if ('agentId' in ((args as { select?: object }).select ?? {})) return null;
    return { ...row };
  }) as typeof find;
  prisma.integration.findUnique = (async () => null) as unknown as typeof fingerprint;
  prisma.browserSession.updateMany = (async (args: unknown) => {
    const { where, data } = args as { where: { sessionId: string }; data: Partial<typeof row> };
    if (Object.entries(where).some(([key, value]) => row[key as keyof typeof row] !== value)) {
      return { count: 0 };
    }
    Object.assign(row, data);
    return { count: 1 };
  }) as typeof update;
  prisma.browserProviderProfile.upsert = (async () => ({})) as unknown as typeof remember;
  prisma.browserContext.update = (async () => ({})) as unknown as typeof contextUpdate;
  steel.sessions.release = (async (id: string) => {
    nodeAssert.strictEqual(id, 'offline-source');
    nodeAssert.strictEqual(row.status, 'PAUSED', 'source release must retain recovery custody');
    releases++;
    if (ready) throw Object.assign(new Error('already released'), { status: 404 });
    ready = true;
    return {};
  }) as typeof release;
  steel.get = (async (path: string) => {
    nodeAssert.strictEqual(path, '/v1/profiles/offline-profile');
    nodeAssert(ready, 'profile readiness must follow acknowledged source release');
    nodeAssert.strictEqual(row.status, 'PAUSED', 'readiness must retain recovery custody');
    profileReads++;
    return { status: 'READY' };
  }) as typeof get;
  steel.sessions.create = (async (input: { profileId?: string }) => {
    if (!ready) {
      throw Object.assign(
        new Error(
          "409 Profile 'offline-profile' is still uploading and cannot be attached to a session yet. Wait for its status to become 'ready', then retry."
        ),
        { status: 409 }
      );
    }
    nodeAssert(profileReads > 0, 'replacement create requires native profile readiness');
    nodeAssert.strictEqual(row.status, 'PAUSED');
    nodeAssert.strictEqual(row.closedAt, null);
    nodeAssert.strictEqual(input.profileId, 'offline-profile');
    if (failCreate) throw Object.assign(new Error('offline create failed'), { status: 429 });
    return {
      id: 'offline-replacement',
      debugUrl: 'https://offline.invalid',
      profileId: 'offline-profile',
    };
  }) as typeof create;
  chromium.connectOverCDP = (async () =>
    ({
      contexts: () => [{ pages: () => [{}] }],
      close: async () => {},
    }) as unknown as Browser) as typeof connect;
  try {
    if (retryReleased) {
      await nodeAssert.rejects(
        () => recreateSession('offline-task', { forceManagedRotation: true }),
        /offline create failed/
      );
      nodeAssert.strictEqual(row.status, 'PAUSED');
      nodeAssert.strictEqual(row.closedAt, null);
      nodeAssert.strictEqual(row.sessionId, 'offline-source');
      failCreate = false;
      const recovered = await recreateSession('offline-task', { forceManagedRotation: true });
      nodeAssert.strictEqual(recovered.previousSessionReleased, true);
      nodeAssert.strictEqual(
        releases,
        2,
        'second invocation must use the existing idempotent release404 contract'
      );
    } else {
      const result = await rotateProxy('offline-task', {
        provider: 'steel',
        proxyType: 'residential',
        recoveryAction: 'ip_rotated',
      });
      nodeAssert.strictEqual(result.sessionId, 'offline-replacement');
      nodeAssert.strictEqual(releases, 1, 'facade released the source a second time');
    }
    nodeAssert.strictEqual(row.status, 'ACTIVE');
    nodeAssert.strictEqual(row.sessionId, 'offline-replacement');
    nodeAssert.strictEqual(leaseReleases, retryReleased ? 2 : 1);
  } finally {
    prisma.browserSession.findUnique = find;
    prisma.integration.findUnique = fingerprint;
    prisma.browserSession.updateMany = update;
    prisma.browserProviderProfile.upsert = remember;
    prisma.browserContext.update = contextUpdate;
    steel.sessions.create = create;
    steel.sessions.release = release;
    steel.get = get;
    chromium.connectOverCDP = connect;
    prisma.$transaction = transaction;
    prisma.toolSideEffect.updateMany = leaseUpdate;
  }
}
