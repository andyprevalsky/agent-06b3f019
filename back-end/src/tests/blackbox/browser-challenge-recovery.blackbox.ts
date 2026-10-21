#!/usr/bin/env tsx

import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import type { Browser } from 'playwright';
import { prisma } from '../../providers/database';
import { DEFAULT_GEOLOCATION } from '../../providers/geoip';
import {
  createSessionWithContextUsingDependencies,
  type BrowserSessionCreationDependencies,
} from '../../providers/browser';
import {
  searchAndPromoteBrowserConfig,
  type BrowserConfigSearchRuntimeDependencies,
} from '../../providers/browser/challengeRecovery';
import type { BrowserProxyRotationResult } from '../../providers/browser';
import type { RotationStep } from '../../providers/browser/rotation';
import {
  resumeBrowserSession,
  rotateBrowserProxy,
  type BrowserSessionResumeDependencies,
} from '../../providers/browserSessionResume';

config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';

interface HttpResult {
  status: number;
  data: unknown;
}

interface AnonymousSession {
  token: string;
  userId: string;
}

const tests: Array<{ name: string; run: () => Promise<void> }> = [];

function test(name: string, run: () => Promise<void>): void {
  tests.push({ name, run });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function request(path: string, options: RequestInit = {}): Promise<HttpResult> {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const data = (await response.headers.get('content-type')?.includes('application/json'))
    ? await response.json()
    : await response.text();
  return { status: response.status, data };
}

async function createAnonymousSession(): Promise<AnonymousSession> {
  const response = await request('/api/auth/anonymous', { method: 'POST' });
  assert(response.status === 200, `anonymous auth failed: ${JSON.stringify(response.data)}`);
  const data = response.data as {
    session: { access_token: string };
    user: { id: string };
  };
  return { token: data.session.access_token, userId: data.user.id };
}

function recoveryBody(taskId: string, currentUrl = 'https://order.online/store/blue-bottle') {
  return JSON.stringify({
    task_id: taskId,
    current_url: currentUrl,
    storage_state: {
      cookies: [
        {
          name: 'authState',
          value: 'opaque',
          domain: '.order.online',
          path: '/',
        },
      ],
      origins: [
        {
          origin: 'https://order.online',
          localStorage: [{ name: 'cart', value: 'preserve' }],
          indexedDB: [],
        },
      ],
    },
  });
}

test('recover-challenge requires authentication', async () => {
  const response = await request('/api/browser-session/recover-challenge', {
    method: 'POST',
    body: recoveryBody(randomUUID()),
  });
  assert(response.status === 401, `expected 401, received ${response.status}`);
});

test('recover-challenge rejects an invalid URL', async () => {
  const response = await request('/api/browser-session/recover-challenge', {
    method: 'POST',
    headers: { 'X-API-Key': API_KEY },
    body: recoveryBody(randomUUID(), 'not-a-url'),
  });
  assert(response.status === 400, `expected 400, received ${response.status}`);
  assert(
    (response.data as { error?: string }).error === 'Invalid recover-challenge request',
    `unexpected validation response: ${JSON.stringify(response.data)}`
  );
});

test('recover-challenge returns 404 before any provider work for a missing task', async () => {
  const response = await request('/api/browser-session/recover-challenge', {
    method: 'POST',
    headers: { 'X-API-Key': API_KEY },
    body: recoveryBody(randomUUID()),
  });
  assert(response.status === 404, `expected 404, received ${response.status}`);
});

test('captcha telemetry requires authentication', async () => {
  const response = await request(`/api/browser-session/${randomUUID()}/captcha-telemetry`);
  assert(response.status === 401, `expected 401, received ${response.status}`);
});

test('captcha telemetry returns 404 before provider work for a missing task', async () => {
  const response = await request(`/api/browser-session/${randomUUID()}/captcha-telemetry`, {
    headers: { 'X-API-Key': API_KEY },
  });
  assert(response.status === 404, `expected 404, received ${response.status}`);
});

async function testTenantIsolation(): Promise<void> {
  const owner = await createAnonymousSession();
  const otherUser = await createAnonymousSession();
  const context = await prisma.browserContext.create({
    data: { userId: owner.userId, contextId: null },
  });
  const session = await prisma.browserSession.create({
    data: {
      contextId: context.id,
      agentId: randomUUID(),
      sessionId: `challenge-blackbox-${randomUUID()}`,
      debugUrl: 'https://debug.invalid/session',
      wsUrl: 'wss://cdp.invalid/session',
      status: 'ACTIVE',
      provider: 'kernel',
    },
  });

  try {
    const headers = { Authorization: `Bearer ${otherUser.token}` };
    const recovery = await request('/api/browser-session/recover-challenge', {
      method: 'POST',
      headers,
      body: recoveryBody(session.id),
    });
    assert(recovery.status === 404, `cross-tenant recovery returned ${recovery.status}`);

    const telemetry = await request(`/api/browser-session/${session.id}/captcha-telemetry`, {
      headers,
    });
    assert(telemetry.status === 404, `cross-tenant telemetry returned ${telemetry.status}`);
  } finally {
    await prisma.browserSession.delete({ where: { id: session.id } }).catch(() => undefined);
    await prisma.browserContext.delete({ where: { id: context.id } }).catch(() => undefined);
  }
}

test('recovery and telemetry hide another user task', testTenantIsolation);

async function testConfigSearchPersistsAndReusesWinnerWithoutChildChips(): Promise<void> {
  const owner = await createAnonymousSession();
  const agent = await prisma.agent.create({
    data: { userId: owner.userId, goal: 'Test browser recovery cache' },
  });
  const context = await prisma.browserContext.create({
    data: { userId: owner.userId, contextId: null },
  });
  const session = await prisma.browserSession.create({
    data: {
      contextId: context.id,
      agentId: agent.id,
      sessionId: `original-${randomUUID()}`,
      debugUrl: 'https://debug.invalid/original',
      wsUrl: 'wss://cdp.invalid/original',
      status: 'ACTIVE',
      provider: 'kernel',
    },
  });
  const created: string[] = [];
  const released: string[] = [];
  // Live view must learn the promoted binding before the original session dies.
  const bindingEvents: string[] = [];
  let sequence = 0;
  const candidate = (provider: 'kernel' | 'steel', proxySource: string) => {
    sequence += 1;
    created.push(proxySource);
    return {
      sessionId: `${provider}-candidate-${sequence}`,
      debugUrl: `https://${provider}.invalid/${sequence}`,
      wsUrl: `wss://${provider}.invalid/${sequence}`,
      proxySource,
      proxyLocation: DEFAULT_GEOLOCATION,
      profileId: null,
      profileSource: 'challenge_candidate_ephemeral',
      validationBrowser: {} as Browser,
    };
  };
  const runtime: BrowserConfigSearchRuntimeDependencies = {
    createKernel: async (_agentId, _location, proxy) =>
      candidate('kernel', `${proxy.type}_${proxy.specificity}`),
    createSteel: async (input) => candidate('steel', input.proxyMode),
    releaseKernel: async (sessionId) => {
      released.push(sessionId);
      bindingEvents.push(`release:${sessionId}`);
    },
    releaseSteel: async (sessionId) => {
      released.push(sessionId);
      bindingEvents.push(`release:${sessionId}`);
    },
    announceBinding: async (where) => {
      const row = await prisma.browserSession.findUniqueOrThrow({ where });
      bindingEvents.push(`announce:${row.sessionId}`);
    },
    probe: async (candidateSession) => ({
      // Lane search promotes the first fully-stable config. Residential city is
      // probed before ISP when geolocation has a city, so only ISP may pass.
      stablePasses: candidateSession.proxySource === 'isp_city' ? 2 : 1,
      attempts: 2,
      latencyMs: candidateSession.proxySource === 'isp_city' ? 1 : 100,
      paymentCdnOk: false,
    }),
  };

  try {
    const beforeRows = await prisma.browserSession.count({ where: { contextId: context.id } });
    const beforeMessages = await prisma.message.count({ where: { agentId: agent.id } });
    const result = await searchAndPromoteBrowserConfig(
      {
        taskId: session.id,
        userId: owner.userId,
        targetUrl: 'https://order.online/store/blue-bottle',
        storageState: { cookies: [], origins: [] },
      },
      runtime
    );

    assert(result.provider === 'kernel', `unexpected winner: ${result.provider}`);
    assert(result.proxy_tier === 'isp_city', `unexpected tier: ${result.proxy_tier}`);
    assert(
      created.length === 6,
      `expected six probed provider sessions before ISP wins (steel_fixed-first order), saw ${created.length}`
    );
    const afterRows = await prisma.browserSession.count({ where: { contextId: context.id } });
    const afterMessages = await prisma.message.count({ where: { agentId: agent.id } });
    assert(afterRows === beforeRows, 'config search created a child BrowserSession row');
    assert(afterMessages === beforeMessages, 'config search emitted a child browser chip/message');
    assert(
      released.length === 6,
      `expected five partial-clear losers plus original release, saw ${released.length}`
    );
    const announced = bindingEvents.findIndex((event) => event.startsWith('announce:'));
    assert(announced >= 0, `promote never announced the winner: ${JSON.stringify(bindingEvents)}`);
    assert(
      bindingEvents[announced] !== `announce:${session.sessionId}`,
      `promote announced the old binding: ${JSON.stringify(bindingEvents)}`
    );
    assert(
      announced < bindingEvents.indexOf(`release:${session.sessionId}`),
      `original session released before the live view learned the winner: ${JSON.stringify(bindingEvents)}`
    );

    const persisted = await prisma.browserContext.findUniqueOrThrow({ where: { id: context.id } });
    const cached = persisted.preferredBrowserConfig as {
      provider?: string;
      kernelProxyType?: string;
      kernelSpecificity?: string;
    } | null;
    assert(cached?.provider === 'kernel', 'winner provider was not persisted');
    assert(cached.kernelProxyType === 'isp', 'winner proxy type was not persisted');
    assert(cached.kernelSpecificity === 'city', 'winner specificity was not persisted');

    const kernelOptions: unknown[] = [];
    let steelCreates = 0;
    const creationDependencies: BrowserSessionCreationDependencies = {
      readPreferredConfig: async (contextId) =>
        (
          await prisma.browserContext.findUnique({
            where: { id: contextId },
            select: { preferredBrowserConfig: true },
          })
        )?.preferredBrowserConfig,
      defaultProvider: () => 'steel',
      createKernel: async (_contextId, _agentId, location, _startUrl, options) => {
        kernelOptions.push(options);
        return {
          provider: 'kernel',
          sessionId: 'cached-kernel-session',
          debugUrl: 'https://kernel.invalid/cached',
          taskId: 'cached-task',
          wsUrl: 'wss://kernel.invalid/cached',
          proxySource: 'isp_city',
          proxyLocation: location,
          profileId: null,
          profileSource: 'test',
          validationBrowser: null,
        };
      },
      createSteel: async () => {
        steelCreates += 1;
        throw new Error('deployment default must not run before cached winner');
      },
    };
    const next = await createSessionWithContextUsingDependencies(
      context.id,
      agent.id,
      DEFAULT_GEOLOCATION,
      undefined,
      undefined,
      creationDependencies
    );
    assert(next.provider === 'kernel', 'next session ignored the persisted winner');
    assert(steelCreates === 0, 'next session tried deployment default before persisted winner');
    assert(
      JSON.stringify(kernelOptions) ===
        JSON.stringify([{ exactManagedProxy: { type: 'isp', specificity: 'city' } }]),
      `next session did not receive exact cached config: ${JSON.stringify(kernelOptions)}`
    );
  } finally {
    await prisma.browserSession.delete({ where: { id: session.id } }).catch(() => undefined);
    await prisma.browserContext.delete({ where: { id: context.id } }).catch(() => undefined);
    await prisma.agent.delete({ where: { id: agent.id } }).catch(() => undefined);
  }
}

test(
  'config search persists the winner and the next session reuses it without child chips',
  testConfigSearchPersistsAndReusesWinnerWithoutChildChips
);

// ---------------------------------------------------------------------------
// Mid-run provider switches persist (Tilion is the deployment default).
// Provider operations are fakes that apply the same BrowserSession row writes
// the real providers make; the ladder, the persisted-provider read, the state
// carried into the replacement and the promoted preference are the real code.
// ---------------------------------------------------------------------------

async function withEnv<T>(values: Record<string, string | undefined>, run: () => Promise<T>) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
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

const TILION_DEFAULT_ENV = {
  BROWSER_PROVIDER: 'tilion',
  BROWSER_AGENT_TILION_ENABLED: undefined,
  BROWSER_AGENT_BROWSER_USE_ENABLED: undefined,
  TILION_API_KEY: 'fake-tilion-key',
};

async function seedRun(provider: string, proxyTier: string | null = null) {
  // Direct fixture rows: these cases exercise provider persistence, not HTTP auth.
  const owner = { userId: `tilion-switch-${randomUUID()}` };
  await prisma.user.create({ data: { userId: owner.userId } });
  const agent = await prisma.agent.create({
    data: { userId: owner.userId, goal: 'Test mid-run provider switch persistence' },
  });
  const context = await prisma.browserContext.create({
    data: { userId: owner.userId, contextId: null },
  });
  const session = await prisma.browserSession.create({
    data: {
      contextId: context.id,
      agentId: agent.id,
      sessionId: `${provider}-original-${randomUUID()}`,
      debugUrl: `https://${provider}.invalid/original`,
      wsUrl: `wss://${provider}.invalid/original`,
      startUrl: 'https://shop.example.com/',
      currentUrl: 'https://shop.example.com/cart',
      status: 'ACTIVE',
      provider,
      proxyTier,
    },
  });
  const cleanup = async () => {
    await prisma.browserSession.delete({ where: { id: session.id } }).catch(() => undefined);
    await prisma.browserContext.delete({ where: { id: context.id } }).catch(() => undefined);
    await prisma.agent.delete({ where: { id: agent.id } }).catch(() => undefined);
    await prisma.user.delete({ where: { userId: owner.userId } }).catch(() => undefined);
  };
  return { owner, agent, context, session, cleanup };
}

/** Fake provider operations that write the row the way the real providers do. */
function fakeProviderOperations() {
  const steps: RotationStep[] = [];
  const injected: Array<{ sessionId: string; userId: string; url: string }> = [];
  const resumedFrom: string[] = [];
  const replacements: string[] = [];
  const carriedStates: unknown[] = [];
  const closedValidation: string[] = [];
  let sequence = 0;
  const replace = async (taskId: string, provider: string, proxyTier: string | null) => {
    sequence += 1;
    const sessionId = `${provider}-replacement-${sequence}-${randomUUID()}`;
    const row = await prisma.browserSession.update({
      where: { id: taskId },
      data: {
        sessionId,
        provider,
        proxyTier,
        wsUrl: `wss://${provider}.invalid/${sequence}`,
        debugUrl: `https://${provider}.invalid/${sequence}`,
        status: 'ACTIVE',
        closedAt: null,
      },
    });
    replacements.push(sessionId);
    return {
      // Tilion accepts one CDP client: this create-time client must be closed
      // before the route answers, or the worker's attach is refused with 4409.
      validationBrowser: {
        close: async () => {
          closedValidation.push(sessionId);
        },
      } as unknown as Browser,
      provider: provider as 'kernel' | 'steel' | 'tilion',
      sessionId,
      debugUrl: row.debugUrl ?? '',
      wsUrl: row.wsUrl ?? '',
      savedUrl: row.currentUrl ?? row.startUrl ?? undefined,
      proxySource: `${provider}_${proxyTier ?? 'resume'}`,
      proxyLocation: DEFAULT_GEOLOCATION,
      profileId: null,
      profileSource: 'test',
    };
  };
  const dependencies: BrowserSessionResumeDependencies = {
    rotateProxy: async (taskId, step, options): Promise<BrowserProxyRotationResult> => {
      steps.push(step);
      carriedStates.push((options as { carriedState?: unknown } | undefined)?.carriedState);
      const before = await prisma.browserSession.findUniqueOrThrow({ where: { id: taskId } });
      const session = await replace(taskId, step.provider, step.proxyType);
      return {
        ...session,
        previousProvider: before.provider as BrowserProxyRotationResult['previousProvider'],
        recoveryAction: step.recoveryAction,
        proxyType: step.proxyType,
      };
    },
    // Resume dispatches on the persisted provider (index.ts providerForTask).
    resumeSession: async (taskId, options) => {
      carriedStates.push((options as { carriedState?: unknown } | undefined)?.carriedState);
      const row = await prisma.browserSession.findUniqueOrThrow({ where: { id: taskId } });
      resumedFrom.push(row.provider);
      return replace(taskId, row.provider, row.proxyTier);
    },
    injectUserData: async (sessionId, userId, url) => {
      injected.push({ sessionId, userId, url });
      return {
        cookies: { injected: true, cookieCount: 3, authSource: 'none', credentialRef: null },
        fingerprint: { injected: false },
      } as unknown as Awaited<ReturnType<BrowserSessionResumeDependencies['injectUserData']>>;
    },
    closeSession: async () => undefined,
    getBrowserCaptchaTelemetry: async () => null as never,
  };
  return {
    dependencies,
    steps,
    injected,
    resumedFrom,
    replacements,
    closedValidation,
    carriedStates,
  };
}

async function testTilionToKernelSwitchPersistsThroughPauseResume(): Promise<void> {
  const run = await seedRun('tilion', 'residential');
  const fake = fakeProviderOperations();
  try {
    await withEnv(TILION_DEFAULT_ENV, async () => {
      const first = await rotateBrowserProxy(
        run.session.id,
        run.owner.userId,
        undefined,
        {},
        fake.dependencies
      );
      assert(first.provider === 'tilion', `rotation 1 left Tilion: ${first.provider}`);
      assert(first.next_recovery === 'rotate_tilion_mobile_ip', `next: ${first.next_recovery}`);
      const second = await rotateBrowserProxy(
        run.session.id,
        run.owner.userId,
        'https://shop.example.com/checkout',
        {},
        fake.dependencies
      );
      assert(second.proxy_tier === 'mobile', `rotation 2 tier: ${second.proxy_tier}`);
      assert(second.next_recovery === 'switch_provider_to_kernel', `${second.next_recovery}`);
      const third = await rotateBrowserProxy(
        run.session.id,
        run.owner.userId,
        undefined,
        {},
        fake.dependencies
      );
      assert(third.provider === 'kernel', `rotation 3 provider: ${third.provider}`);
      assert(third.recovery_action === 'provider_switched', `${third.recovery_action}`);
      assert(third.previous_provider === 'tilion', `previous: ${third.previous_provider}`);
      assert(
        /^Switched from Tilion to Kernel/.test(third.rotation_message),
        third.rotation_message
      );
      // Ladder position 4 reads the persisted Kernel provider, not the Tilion default.
      assert(third.next_recovery === 'switch_provider_to_steel', `${third.next_recovery}`);
      assert(
        third.cookies_injected && third.saved_url === 'https://shop.example.com/checkout',
        `state not carried into Kernel: ${JSON.stringify(third)}`
      );

      // Pause, then resume: the run stays on Kernel with its URL and state.
      await prisma.browserSession.update({
        where: { id: run.session.id },
        data: { status: 'PAUSED', closedAt: new Date() },
      });
      const resumed = await resumeBrowserSession(run.session.id, {}, fake.dependencies);
      assert(
        resumed.browser_session_metadata.provider === 'kernel',
        `resume reverted the switched provider: ${resumed.browser_session_metadata.provider}`
      );
      assert(resumed.current_url === 'https://shop.example.com/checkout', resumed.current_url!);
      const row = await prisma.browserSession.findUniqueOrThrow({ where: { id: run.session.id } });
      assert(row.provider === 'kernel', `persisted provider after resume: ${row.provider}`);
      assert(row.status === 'ACTIVE', `resumed row status: ${row.status}`);
      assert(row.proxyRotationCount === 3, `rotation budget changed: ${row.proxyRotationCount}`);
      const last = fake.injected[fake.injected.length - 1]!;
      assert(
        last.sessionId === row.sessionId &&
          last.userId === run.owner.userId &&
          last.url === 'https://shop.example.com/checkout',
        `state not injected into the resumed Kernel session: ${JSON.stringify(last)}`
      );

      // The fourth rotation follows the persisted provider too.
      const fourth = await rotateBrowserProxy(
        run.session.id,
        run.owner.userId,
        undefined,
        {},
        fake.dependencies
      );
      assert(fourth.provider === 'steel', `rotation 4 provider: ${fourth.provider}`);

      // A resume with no saved URL skips injection and still releases the client.
      await prisma.browserSession.update({
        where: { id: run.session.id },
        data: { status: 'PAUSED', currentUrl: null, startUrl: null },
      });
      await resumeBrowserSession(run.session.id, {}, fake.dependencies);
    });
    assert(
      JSON.stringify(fake.closedValidation) === JSON.stringify(fake.replacements),
      `validation clients left open: replaced ${JSON.stringify(fake.replacements)}, ` +
        `closed ${JSON.stringify(fake.closedValidation)}`
    );
    assert(
      JSON.stringify(fake.steps.map((step) => [step.provider, step.proxyType])) ===
        JSON.stringify([
          ['tilion', 'residential'],
          ['tilion', 'mobile'],
          ['kernel', 'residential'],
          ['steel', 'residential'],
        ]),
      `unexpected ladder: ${JSON.stringify(fake.steps)}`
    );
    assert(
      JSON.stringify(fake.resumedFrom) === JSON.stringify(['kernel', 'steel']),
      `resume dispatched on ${JSON.stringify(fake.resumedFrom)}`
    );
  } finally {
    await run.cleanup();
  }
}

test(
  'Tilion → Kernel rotation switch persists through pause/resume with its state',
  testTilionToKernelSwitchPersistsThroughPauseResume
);

async function testWorkerCapturedStateReachesTilionReplacement(): Promise<void> {
  const run = await seedRun('tilion', 'residential');
  const fake = fakeProviderOperations();
  // The worker captures the live session's state over its own (only) CDP socket.
  const workerState = {
    cookies: [
      {
        name: 'cart',
        value: 'three-items',
        domain: '.shop.example.com',
        path: '/',
        expires: -1,
        httpOnly: false,
        secure: true,
        sameSite: 'Lax' as const,
      },
    ],
    origins: [
      {
        origin: 'https://shop.example.com',
        localStorage: [{ name: 'checkoutStep', value: 'shipping' }],
        indexedDB: [],
      },
    ],
  };
  try {
    await withEnv(TILION_DEFAULT_ENV, async () => {
      await rotateBrowserProxy(
        run.session.id,
        run.owner.userId,
        undefined,
        { carriedState: workerState },
        fake.dependencies
      );
      await rotateBrowserProxy(run.session.id, run.owner.userId, undefined, {}, fake.dependencies);
      await prisma.browserSession.update({
        where: { id: run.session.id },
        data: { status: 'PAUSED' },
      });
      await resumeBrowserSession(run.session.id, { carriedState: workerState }, fake.dependencies);
    });
    assert(
      fake.steps[0]?.provider === 'tilion' && fake.steps[0].proxyType === 'residential',
      `first step was not a Tilion rotation: ${JSON.stringify(fake.steps)}`
    );
    assert(
      fake.carriedStates[0] === workerState,
      `Tilion rotation did not receive the worker's storage_state: ${JSON.stringify(fake.carriedStates[0])}`
    );
    assert(
      fake.carriedStates[1] === undefined,
      'a rotation without worker state invented a carried state'
    );
    assert(
      fake.carriedStates[2] === workerState,
      `resume did not receive the worker's storage_state: ${JSON.stringify(fake.carriedStates[2])}`
    );
  } finally {
    await run.cleanup();
  }
}

test(
  'worker-captured storage_state reaches the Tilion rotation and resume replacement',
  testWorkerCapturedStateReachesTilionReplacement
);

async function testKernelToTilionPromotionPersistsAndIsHonoured(): Promise<void> {
  const run = await seedRun('kernel', 'residential_city');
  const created: string[] = [];
  const released: string[] = [];
  const closedProbeClients: string[] = [];
  const probedWsUrls: string[] = [];
  const validationClient = (sessionId: string) =>
    ({
      close: async () => {
        closedProbeClients.push(sessionId);
      },
    }) as unknown as Browser;
  const candidate = (provider: string, proxySource: string) => {
    const sessionId = `${provider}-candidate-${created.length + 1}`;
    created.push(proxySource);
    return {
      sessionId,
      debugUrl: `https://${provider}.invalid/${sessionId}`,
      wsUrl: `wss://${provider}.invalid/${sessionId}`,
      proxySource,
      proxyLocation: DEFAULT_GEOLOCATION,
      profileId: null,
      profileSource: 'challenge_candidate_ephemeral',
      validationBrowser: validationClient(sessionId),
    };
  };
  const tilionCreates: unknown[] = [];
  const runtime: BrowserConfigSearchRuntimeDependencies = {
    createKernel: async (_agentId, _location, proxy) =>
      candidate('kernel', `${proxy.type}_${proxy.specificity}`),
    createSteel: async (input) => candidate('steel', input.proxyMode),
    createBrowserUse: async () => {
      throw new Error('Browser Use is disabled in this test');
    },
    createTilion: async (_location, options) => {
      tilionCreates.push(options);
      return candidate('tilion', `tilion_${options.proxyType}`);
    },
    releaseKernel: async (sessionId) => void released.push(sessionId),
    releaseSteel: async (sessionId) => void released.push(sessionId),
    releaseBrowserUse: async (sessionId) => void released.push(sessionId),
    releaseTilion: async (sessionId) => void released.push(sessionId),
    refreshTilionConnectUrl: async (sessionId) => `wss://tilion.invalid/${sessionId}?token=fresh`,
    announceBinding: async () => undefined,
    probe: async (candidateSession) => {
      probedWsUrls.push(candidateSession.wsUrl);
      const clean = candidateSession.proxySource === 'tilion_mobile';
      return { stablePasses: clean ? 1 : 0, attempts: 1, latencyMs: 1, paymentCdnOk: true };
    },
  };
  const fake = fakeProviderOperations();
  try {
    const result = await withEnv({ ...TILION_DEFAULT_ENV, BROWSER_PROVIDER: 'kernel' }, async () =>
      searchAndPromoteBrowserConfig(
        {
          taskId: run.session.id,
          userId: run.owner.userId,
          targetUrl: 'https://shop.example.com/cart',
          storageState: { cookies: [], origins: [] },
          fingerprintInjection: null,
        },
        runtime
      )
    );
    assert(result.provider === 'tilion', `winner provider: ${result.provider}`);
    assert(result.recovery_action === 'provider_switched', result.recovery_action);
    const freshUrl = `wss://tilion.invalid/${result.session_id}?token=fresh`;
    assert(
      result.ws_url === freshUrl,
      `promoted Tilion URL was not freshly minted: ${result.ws_url}`
    );
    assert(
      JSON.stringify(tilionCreates.at(-1)) === JSON.stringify({ proxyType: 'mobile' }),
      `Tilion exit type not requested: ${JSON.stringify(tilionCreates)}`
    );
    // Recovery never opens a client on the live session (storage comes from the worker).
    assert(!probedWsUrls.includes(run.session.wsUrl!), 'probe touched the live session');
    // Tilion allows one CDP client: the winner's probe client is gone before the agent reattaches.
    assert(closedProbeClients.includes(result.session_id), 'Tilion probe client left attached');
    assert(released.includes(run.session.sessionId), 'superseded Kernel session not released');
    assert(!released.includes(result.session_id), 'promoted Tilion session was released');

    const row = await prisma.browserSession.findUniqueOrThrow({ where: { id: run.session.id } });
    assert(row.provider === 'tilion', `persisted provider: ${row.provider}`);
    assert(row.sessionId === result.session_id, 'promoted session id not persisted');
    assert(row.wsUrl === freshUrl, `persisted URL is not the fresh one: ${row.wsUrl}`);
    assert(row.kernelProxySource === null, 'Kernel proxy source survived the switch');
    const context = await prisma.browserContext.findUniqueOrThrow({
      where: { id: run.context.id },
    });
    const preferred = context.preferredBrowserConfig as {
      provider?: string;
      tilionProxyType?: string;
    } | null;
    assert(preferred?.provider === 'tilion', `preferred: ${JSON.stringify(preferred)}`);
    assert(preferred.tilionProxyType === 'mobile', `preferred: ${JSON.stringify(preferred)}`);

    // With Kernel as the deployment default, the next rotation reads the
    // persisted Tilion provider and stays on the Tilion ladder.
    await withEnv({ ...TILION_DEFAULT_ENV, BROWSER_PROVIDER: 'kernel' }, async () => {
      const rotated = await rotateBrowserProxy(
        run.session.id,
        run.owner.userId,
        undefined,
        {},
        fake.dependencies
      );
      assert(rotated.provider === 'tilion', `rotation after promotion: ${rotated.provider}`);
      assert(rotated.recovery_action === 'ip_rotated', rotated.recovery_action);
    });
    // Kill switch off: the Tilion run leaves for Kernel at the ladder's tier.
    await withEnv({ ...TILION_DEFAULT_ENV, BROWSER_AGENT_TILION_ENABLED: 'false' }, async () => {
      const rotated = await rotateBrowserProxy(
        run.session.id,
        run.owner.userId,
        undefined,
        {},
        fake.dependencies
      );
      assert(rotated.provider === 'kernel', `kill switch rotated into ${rotated.provider}`);
      assert(rotated.proxy_tier === 'mobile', `kill switch tier: ${rotated.proxy_tier}`);
      assert(rotated.recovery_action === 'provider_switched', rotated.recovery_action);
    });

    // The promoted preference is honoured by the next new session.
    const tilionOptions: unknown[] = [];
    const creationDependencies = {
      readPreferredConfig: async (contextId: string) =>
        (
          await prisma.browserContext.findUnique({
            where: { id: contextId },
            select: { preferredBrowserConfig: true },
          })
        )?.preferredBrowserConfig,
      defaultProvider: () => 'kernel' as const,
      createKernel: async () => {
        throw new Error('deployment default must not run before the promoted Tilion winner');
      },
      createSteel: async () => {
        throw new Error('a Tilion preference must never fall through to Steel');
      },
      createBrowserUse: async () => {
        throw new Error('Browser Use is disabled in this test');
      },
      createTilion: async (
        _contextId: string,
        _agentId: string,
        location: typeof DEFAULT_GEOLOCATION,
        _startUrl?: string,
        options?: unknown
      ) => {
        tilionOptions.push(options);
        return {
          provider: 'tilion' as const,
          sessionId: 'preferred-tilion-session',
          debugUrl: 'https://tilion.invalid/preferred',
          taskId: 'preferred-task',
          wsUrl: 'wss://tilion.invalid/preferred',
          proxySource: 'tilion_mobile',
          proxyLocation: location,
          profileId: null,
          profileSource: 'test',
          validationBrowser: null,
        };
      },
    } as unknown as BrowserSessionCreationDependencies;
    const next = await withEnv(TILION_DEFAULT_ENV, async () =>
      createSessionWithContextUsingDependencies(
        run.context.id,
        run.agent.id,
        DEFAULT_GEOLOCATION,
        undefined,
        undefined,
        creationDependencies
      )
    );
    assert(next.provider === 'tilion', `next session ignored the Tilion winner: ${next.provider}`);
    assert(
      tilionOptions.length === 1 &&
        (tilionOptions[0] as { proxyType?: string } | undefined)?.proxyType === 'mobile',
      `next session did not receive the Tilion exit type: ${JSON.stringify(tilionOptions)}`
    );
  } finally {
    await run.cleanup();
  }
}

test(
  'Kernel → Tilion recovery promotion persists, rotates on Tilion and is honoured next session',
  testKernelToTilionPromotionPersistsAndIsHonoured
);

async function main(): Promise<void> {
  let failed = 0;
  for (const entry of tests) {
    try {
      await entry.run();
      process.stdout.write(`PASS ${entry.name}\n`);
    } catch (error) {
      failed += 1;
      process.stderr.write(`FAIL ${entry.name}\n`);
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
      );
    }
  }
  process.stdout.write(`\nResults: ${tests.length - failed} passed, ${failed} failed\n`);
  await prisma.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}

void main();
