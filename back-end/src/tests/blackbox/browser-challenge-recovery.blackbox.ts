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
import { registerSameProviderCases } from './browser-challenge-recovery-same-provider.cases';
import { registerTilionSwitchCases } from './browser-challenge-recovery-tilion.cases';
import { registerTilionTransportCases } from './browser-challenge-recovery-tilion-transport.cases';
import { registerTilionCarryCases } from './browser-challenge-recovery-tilion-carry.cases';

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
      defaultProvider: () => 'kernel',
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

registerTilionSwitchCases(test);
registerSameProviderCases(test);
registerTilionTransportCases(test);
registerTilionCarryCases(test);

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
