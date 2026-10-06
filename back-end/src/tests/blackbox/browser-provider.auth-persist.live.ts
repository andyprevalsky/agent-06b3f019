/** Live Kernel/Steel: sign-in survives session close and a later browser-agent call. */
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { prisma } from '../../providers/database';
import { buildPreferredBrowserConfig } from '../../providers/browser/challengeRecovery';
import { releaseKernelRemoteSession } from '../../providers/browser/kernel';
import { releaseSteelRemoteSession } from '../../providers/steel/session';
import { steelCdpConnectionUrl } from '../../providers/steel/urls';
import { deleteKernelProfile } from './browser-provider-rotation.support';
import { assert, navigateKernelPage, retryBackendFetch } from './browser-provider.helpers';

const LOCATION = { country: 'US', state: 'CA', city: 'San Francisco' } as const;

function asRecord(value: unknown): Record<string, unknown> {
  assert(typeof value === 'object' && value !== null, 'Expected JSON object');
  return value as Record<string, unknown>;
}

async function readSignedIn(wsUrl: string): Promise<{ cookie: string; storage: string | null }> {
  const browser = await chromium.connectOverCDP(steelCdpConnectionUrl(wsUrl));
  try {
    const context = browser.contexts()[0];
    assert(context !== undefined, 'resumed browser has no context');
    const page = context.pages()[0] ?? (await context.newPage());
    await navigateKernelPage(page, 'https://example.com');
    return {
      cookie: await page.evaluate(() => document.cookie),
      storage: await page.evaluate(() => localStorage.getItem('rose_handoff')),
    };
  } finally {
    await browser.close();
  }
}

export async function runLiveKernelSteelAuthPersist(): Promise<void> {
  const base = process.env.TEST_BASE_URL?.replace(/\/$/, '');
  const apiKey = process.env.BACKEND_API_KEY?.trim();
  const kernelApiKey = process.env.KERNEL_API_KEY?.trim();
  const steelApiKey = process.env.STEEL_API_KEY?.trim();
  if (!base || !apiKey || !kernelApiKey || !steelApiKey) {
    throw new Error(
      'Live Kernel/Steel auth persist needs TEST_BASE_URL, BACKEND_API_KEY, KERNEL_API_KEY, and STEEL_API_KEY'
    );
  }

  const userId = `auth-persist-live-${randomUUID()}`;
  const headers = { 'content-type': 'application/json', 'x-api-key': apiKey, 'x-user-id': userId };
  const allocated: Array<{ sessionId: string; provider: string; profileId?: string }> = [];
  const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
    const response = await retryBackendFetch(`${base}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const data = asRecord(await response.json());
    if (!response.ok) throw new Error(`${path} HTTP ${response.status}: ${JSON.stringify(data)}`);
    return data;
  };

  await prisma.user.create({ data: { userId, name: 'Auth persist live' } });
  const context = await prisma.browserContext.create({ data: { userId } });
  const startAgent = async (goal: string) =>
    prisma.agent.create({
      data: {
        userId,
        goal,
        proxyCountry: LOCATION.country,
        proxyState: LOCATION.state,
        proxyCity: LOCATION.city,
      },
    });

  try {
    const firstAgent = await startAgent('Sign in on Kernel');
    const initial = await post('/api/browser-session/init', {
      user_id: userId,
      agent_id: firstAgent.id,
      start_url: 'https://example.com',
    });
    const firstSessionId = String(initial.session_id);
    const firstMeta = asRecord(initial.browser_session_metadata);
    assert(firstMeta.provider === 'kernel', 'first browser-agent call did not select Kernel');
    allocated.push({
      sessionId: firstSessionId,
      provider: 'kernel',
      profileId: String(firstMeta.profile_id ?? ''),
    });

    const remote = await chromium.connectOverCDP(String(initial.ws_url));
    try {
      const page = remote.contexts()[0]?.pages()[0] ?? (await remote.contexts()[0]!.newPage());
      await navigateKernelPage(page, 'https://example.com');
      await page.evaluate(() => {
        document.cookie = 'session=signed-in; path=/; max-age=600; SameSite=Lax';
        localStorage.setItem('rose_handoff', 'signed-in');
      });
    } finally {
      await remote.close();
    }

    await post('/api/browser-session/close', {
      session_id: firstSessionId,
      pause: false,
      current_url: 'https://example.com',
    });

    await prisma.browserContext.update({
      where: { id: context.id },
      data: {
        preferredBrowserConfig: buildPreferredBrowserConfig(
          { provider: 'steel', proxyMode: 'residential_country', steelProxyMode: 'managed' },
          LOCATION
        ),
      },
    });
    const steelAgent = await startAgent('Resume signed-in state on Steel');
    const switched = await post('/api/browser-session/init', {
      user_id: userId,
      agent_id: steelAgent.id,
      start_url: 'https://example.com',
    });
    const switchedMeta = asRecord(switched.browser_session_metadata);
    const switchedProvider = String(switchedMeta.provider);
    allocated.push({
      sessionId: String(switched.session_id),
      provider: switchedProvider,
      profileId: String(switchedMeta.profile_id ?? ''),
    });
    const switchedState = await readSignedIn(String(switched.ws_url));
    assert(
      switchedState.cookie.includes('session=signed-in'),
      `${switchedProvider} did not restore the Kernel sign-in cookie`
    );
    assert(
      switchedState.storage === 'signed-in',
      `${switchedProvider} did not restore Kernel localStorage`
    );
    if (switchedProvider !== 'steel') {
      console.warn(
        `WARN live auth persist: preferred Steel fell back to ${switchedProvider}; sequential resume still passed`
      );
    }

    await post('/api/browser-session/close', {
      session_id: String(switched.session_id),
      pause: false,
      current_url: 'https://example.com',
    });

    await prisma.browserContext.update({
      where: { id: context.id },
      data: {
        preferredBrowserConfig: buildPreferredBrowserConfig(
          { provider: 'kernel', proxyMode: 'residential_city', kernelProxyType: 'residential' },
          LOCATION
        ),
      },
    });
    const laterAgent = await startAgent('Pick up signed-in state on a later Kernel call');
    const later = await post('/api/browser-session/init', {
      user_id: userId,
      agent_id: laterAgent.id,
      start_url: 'https://example.com',
    });
    const laterMeta = asRecord(later.browser_session_metadata);
    allocated.push({
      sessionId: String(later.session_id),
      provider: String(laterMeta.provider),
      profileId: String(laterMeta.profile_id ?? ''),
    });
    const laterState = await readSignedIn(String(later.ws_url));
    assert(
      laterState.cookie.includes('session=signed-in') && laterState.storage === 'signed-in',
      'later browser-agent call did not pick up the signed-in session'
    );
    await post('/api/browser-session/close', {
      session_id: String(later.session_id),
      pause: false,
    });
    console.log(
      `PASS live Kernel/Steel auth persist (second=${switchedProvider}, later=${String(laterMeta.provider)})`
    );
  } finally {
    for (const session of allocated) {
      if (session.provider === 'steel') {
        await releaseSteelRemoteSession(session.sessionId).catch(() => undefined);
      } else {
        await releaseKernelRemoteSession(session.sessionId).catch(() => undefined);
      }
      if (session.provider === 'kernel' && session.profileId) {
        await deleteKernelProfile(session.profileId).catch(() => undefined);
      }
    }
    await prisma.browserContext.deleteMany({ where: { userId } });
    await prisma.cookie.deleteMany({ where: { userId } });
    await prisma.cookieBundle.deleteMany({ where: { userId } });
    await prisma.localStorageOrigin.deleteMany({ where: { userId } });
    await prisma.agent.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
  }
}
