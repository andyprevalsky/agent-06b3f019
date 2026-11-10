/** Live Kernel→Steel|Tilion→Kernel: sign-in survives session close and a later browser-agent call. */
import { createHash, randomUUID } from 'node:crypto';
import { withBrowserProviderServer } from './browser-provider.fixture-server.support';
import { chmod, mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';
import { prisma } from '../../providers/database';
import { benchmarkSavedBrowserAuthDisabled } from '../../providers/benchmarkBrowserAuth';
import { CHROME_EPOCH_OFFSET_MICROSECONDS } from '../../domains/integrations/config';
import { buildPreferredBrowserConfig } from '../../providers/browser/challengeRecovery';
import { releaseKernelRemoteSession } from '../../providers/browser/kernel';
import { releaseTilionRemoteSession } from '../../providers/browser/tilion';
import { releaseSteelRemoteSession } from '../../providers/steel/session';
import { steelCdpConnectionUrl } from '../../providers/steel/urls';
import {
  completeCloudBrowserSignIn,
  deleteCloudBrowserSignInEvidence,
} from '../helpers/browser-sign-in-evidence';
import { deleteKernelProfile } from './browser-provider-rotation.support';
import { assert, navigateKernelPage, retryBackendFetch } from './browser-provider.helpers';
import {
  cleanupAuthPersistFixture,
  readAuthPersistInitOnce,
  type AuthPersistCleanupResult,
} from './browser-provider.auth-persist.cleanup';

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

/** The provider the second call is switched to between the two Kernel calls. */
export type AuthPersistMiddleProvider = 'steel' | 'tilion';

function middlePreferredConfig(middle: AuthPersistMiddleProvider) {
  return middle === 'tilion'
    ? buildPreferredBrowserConfig(
        { provider: 'tilion', proxyMode: 'residential_country', tilionProxyType: 'residential' },
        LOCATION
      )
    : buildPreferredBrowserConfig(
        { provider: 'steel', proxyMode: 'residential_country', steelProxyMode: 'managed' },
        LOCATION
      );
}

export async function runLiveKernelSteelAuthPersist(
  middle: AuthPersistMiddleProvider = 'steel'
): Promise<void> {
  await withBrowserProviderServer('kernel', () => runConfiguredAuthPersist(middle));
}

async function runConfiguredAuthPersist(middle: AuthPersistMiddleProvider): Promise<void> {
  const base = process.env.TEST_BASE_URL?.replace(/\/$/, '');
  const apiKey = process.env.BACKEND_API_KEY?.trim();
  const kernelApiKey = process.env.KERNEL_API_KEY?.trim();
  const middleKeyName = middle === 'tilion' ? 'TILION_API_KEY' : 'STEEL_API_KEY';
  const middleApiKey = process.env[middleKeyName]?.trim();
  if (!base || !apiKey || !kernelApiKey || !middleApiKey) {
    throw new Error(
      `Live Kernel/${middle} auth persist needs TEST_BASE_URL, BACKEND_API_KEY, KERNEL_API_KEY, and ${middleKeyName}`
    );
  }

  assert(
    !benchmarkSavedBrowserAuthDisabled(),
    'Live auth persist requires saved browser auth; do not disable it for this fixture'
  );
  const userId = `auth-persist-live-${randomUUID()}`;
  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'x-user-id': userId,
  };
  const allocated: Array<{
    sessionId: string;
    provider: string;
    profileId?: string;
  }> = [];
  // Keep identifiers outside mutable coverage output; never store credentials or URLs.
  const custodyRoot = resolve(__dirname, '../../../../.context/test-runs/browser-provider-custody');
  await mkdir(custodyRoot, { recursive: true, mode: 0o700 });
  const custodyDir = await mkdtemp(join(custodyRoot, 'auth-persist-'));
  await chmod(custodyDir, 0o700);
  const journalPath = join(custodyDir, 'custody.json');
  const marker = `rose-provisioning:${createHash('sha256').update(userId).digest('hex')}`;
  let initUnresolved = false;
  let originalFailure: unknown;
  let userCreated = false;
  let passedMessage: string | undefined;
  let guardBundleId: string | undefined;
  let mintedIdentityObserved = false;
  const snapshot = async () => {
    const [identity, sessions, profiles] = await Promise.all([
      prisma.agentIdentity.findUnique({
        where: { userId },
        select: {
          phoneProvider: true,
          phoneProviderAgentId: true,
          phoneProviderNumberId: true,
        },
      }),
      prisma.browserSession.findMany({
        where: { context: { userId } },
        select: {
          sessionId: true,
          provider: true,
          providerProfileId: true,
          status: true,
        },
      }),
      prisma.browserProviderProfile.findMany({
        where: { context: { userId } },
        select: { provider: true, profileId: true },
      }),
    ]);
    if (identity !== null) mintedIdentityObserved = true;
    return { identity, sessions, profiles };
  };
  const saveJournal = async (
    phase: string,
    custody: unknown = null,
    cleanupResults: AuthPersistCleanupResult[] = [],
    ownerRetained = true
  ) => {
    const temporary = `${journalPath}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify(
        {
          userId,
          marker,
          phase,
          userCreated,
          initUnresolved,
          ownerRetained,
          custody,
          allocated,
          cleanupResults,
          // Error messages can contain provider response bodies; keep them out of artifacts.
          cleanupFailures: cleanupResults.filter((result) => !result.succeeded).length,
        },
        null,
        2
      ),
      { mode: 0o600 }
    );
    await rename(temporary, journalPath);
  };
  // Must succeed before any database setup or provider-capable request.
  await saveJournal('before-setup');
  let initialized = 0;
  const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
    if (path === '/api/browser-session/init') {
      process.env.BROWSER_PROVIDER = initialized++ === 1 ? middle : 'kernel';
      initUnresolved = true;
      await saveJournal('before-init', await snapshot());
    }
    const request = { method: 'POST', headers, body: JSON.stringify(body) };
    // Allocating POSTs are one-shot: a reset can leave the first request running.
    const result =
      path === '/api/browser-session/init'
        ? await readAuthPersistInitOnce(
            () => fetch(`${base}${path}`, request),
            () => {
              initUnresolved = false;
            }
          )
        : await (async () => {
            const response = await retryBackendFetch(`${base}${path}`, request);
            return { response, data: (await response.json()) as unknown };
          })();
    const { response } = result;
    const data = asRecord(result.data);
    if (!response.ok) throw new Error(`${path} HTTP ${response.status}: ${JSON.stringify(data)}`);
    if (path === '/api/browser-session/init') {
      const custody = await snapshot();
      await saveJournal('after-init', custody);
      const authOptions = asRecord(data.auth_options);
      assert(Array.isArray(authOptions.cookie_bundles), 'init must return cookie bundles');
      assert(
        authOptions.cookie_bundles.some((bundle: unknown) => {
          const row = asRecord(bundle);
          return row.id === guardBundleId && row.disabled === false;
        }),
        'init did not expose the exact enabled guard-cookie bundle'
      );
      assert(authOptions.minted === null, 'auth-persist fixture entered unrelated minting');
      assert(custody.identity === null, 'auth-persist fixture minted an AgentIdentity');
    }
    return data;
  };

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
    await prisma.user.create({ data: { userId, name: 'Auth persist live' } });
    userCreated = true;
    // The owned route server selects Kernel for the first and last calls.
    const context = await prisma.browserContext.create({
      data: {
        userId,
        preferredBrowserConfig: buildPreferredBrowserConfig(
          { provider: 'kernel', proxyMode: 'residential_city', kernelProxyType: 'residential' },
          LOCATION
        ),
      },
    });
    // A real independent cookie keeps phone minting outside this persistence test.
    // It cannot satisfy either target state that the live handoff must restore.
    const browserProfile = 'AuthPersistFixture';
    const guardBundle = await prisma.cookieBundle.create({
      data: {
        userId,
        authRealm: 'example.com',
        browserSource: 'chrome',
        browserProfile,
        disabledAt: null,
      },
    });
    guardBundleId = guardBundle.id;
    await prisma.cookie.create({
      data: {
        userId,
        domain: 'example.com',
        name: 'rose_fixture_auth_guard',
        value: 'independent-fixture',
        path: '/',
        browserSource: 'chrome',
        browserProfile,
        hasExpires: false,
        isPersistent: false,
        creationUtc: BigInt(Date.now()) * 1000n + CHROME_EPOCH_OFFSET_MICROSECONDS,
      },
    });
    await saveJournal('setup-complete', await snapshot());
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
      const beforeSignIn = await page.evaluate(() => ({
        cookies: document.cookie,
        storage: localStorage.getItem('rose_handoff'),
      }));
      assert(
        beforeSignIn.cookies
          .split(';')
          .some((cookie) => cookie.trim() === 'rose_fixture_auth_guard=independent-fixture'),
        'the independent fixture cookie was not actually injected'
      );
      assert(
        !beforeSignIn.cookies.split(';').some((cookie) => cookie.trim() === 'session=signed-in'),
        'target sign-in cookie was already present'
      );
      assert(beforeSignIn.storage === null, 'target localStorage was already present');
      await page.evaluate(() => {
        document.cookie = 'session=signed-in; path=/; max-age=600; SameSite=Lax';
        localStorage.setItem('rose_handoff', 'signed-in');
      });
    } finally {
      await remote.close();
    }
    const firstRow = await prisma.browserSession.findUniqueOrThrow({
      where: { sessionId: firstSessionId },
    });
    await completeCloudBrowserSignIn({
      userId,
      agentId: firstAgent.id,
      browserSessionId: firstRow.id,
      steelSessionId: firstSessionId,
      authRealm: 'https://example.com/login',
    });

    await post('/api/browser-session/close', {
      session_id: firstSessionId,
      pause: false,
      current_url: 'https://example.com',
    });

    await prisma.browserContext.update({
      where: { id: context.id },
      data: { preferredBrowserConfig: middlePreferredConfig(middle) },
    });
    const middleAgent = await startAgent(`Resume signed-in state on ${middle}`);
    const switched = await post('/api/browser-session/init', {
      user_id: userId,
      agent_id: middleAgent.id,
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
    if (middle === 'tilion') {
      // The owned route server explicitly selects Tilion for this middle call.
      assert(switchedProvider === 'tilion', `preferred Tilion landed on ${switchedProvider}`);
    } else if (switchedProvider !== 'steel') {
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
          {
            provider: 'kernel',
            proxyMode: 'residential_city',
            kernelProxyType: 'residential',
          },
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
    assert(
      (await prisma.agentIdentity.findUnique({ where: { userId } })) === null,
      'auth-persist fixture created an unrelated identity before completion'
    );
    passedMessage = `PASS live Kernel/${middle} auth persist (second=${switchedProvider}, later=${String(laterMeta.provider)})`;
  } catch (error) {
    originalFailure = error;
    throw error;
  } finally {
    await cleanupAuthPersistFixture({
      userId,
      userCreated,
      initUnresolved,
      allocated,
      originalFailure,
      journalPath,
      snapshot,
      saveJournal,
      releaseBrowser: async (session) => {
        if (session.provider === 'steel') await releaseSteelRemoteSession(session.sessionId);
        else if (session.provider === 'kernel') await releaseKernelRemoteSession(session.sessionId);
        else if (session.provider === 'tilion') await releaseTilionRemoteSession(session.sessionId);
        else throw new Error('Unsupported owned browser provider');
      },
      deleteProfile: deleteKernelProfile,
      cleanupLocal: async (deleteUser) => {
        await deleteCloudBrowserSignInEvidence(userId);
        await prisma.browserContext.deleteMany({ where: { userId } });
        await prisma.cookie.deleteMany({ where: { userId } });
        await prisma.cookieBundle.deleteMany({ where: { userId } });
        await prisma.localStorageOrigin.deleteMany({ where: { userId } });
        await prisma.agent.deleteMany({ where: { userId } });
        // No phone deletion is authorized: retain its identity/lease and User owner.
        if (deleteUser) await prisma.user.deleteMany({ where: { userId } });
      },
    });
  }
  assert(!mintedIdentityObserved, 'auth-persist custody snapshot observed a minted identity');
  if (passedMessage !== undefined) console.log(passedMessage);
}
