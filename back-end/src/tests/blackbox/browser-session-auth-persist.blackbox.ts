#!/usr/bin/env tsx
/**
 * Signed-in Kernel/Steel state must survive session close and land on the
 * other provider (and on a later browser-agent call) via CookieBundle inject,
 * without letting an anonymous realm visit displace the user's real bundle.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { prisma } from '../../providers/database';
import {
  CLOUD_PERSISTENT_BROWSER_PROFILE,
  persistSignedInBrowserState,
} from '../../providers/browser/sessionAuthPersist';
import { injectUserData } from '../../providers/steel/injection';
import {
  completeCloudBrowserSignIn,
  deleteCloudBrowserSignInEvidence,
} from '../helpers/browser-sign-in-evidence';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function listen(): Promise<{
  origin: string;
  localhostOrigin: string;
  close: () => Promise<void>;
}> {
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<body>auth persist fixture</body>');
  });
  // Unspecified host: reachable as both 127.0.0.1 and localhost (two realms).
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    localhostOrigin: `http://localhost:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function signIn(browser: Browser, origin: string, value = 'signed-in'): Promise<void> {
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.evaluate((cookieValue) => {
    document.cookie = `session=${cookieValue}; path=/`;
    localStorage.setItem('rose_handoff', cookieValue);
  }, value);
}

async function recordSignIn(
  session: { id: string; agentId: string; sessionId: string },
  userId: string,
  origin: string
): Promise<void> {
  await completeCloudBrowserSignIn({
    userId,
    agentId: session.agentId,
    browserSessionId: session.id,
    steelSessionId: session.sessionId,
    authRealm: origin,
  });
}

async function readSignIn(browser: Browser, origin: string) {
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  return page.evaluate(() => ({
    cookie: document.cookie,
    localStorage: localStorage.getItem('rose_handoff'),
  }));
}

async function createSession(params: {
  userId: string;
  provider: 'kernel' | 'steel';
  sessionId: string;
}) {
  const context = await prisma.browserContext.upsert({
    where: { userId: params.userId },
    create: { userId: params.userId },
    update: {},
  });
  return prisma.browserSession.create({
    data: {
      contextId: context.id,
      agentId: randomUUID(),
      sessionId: params.sessionId,
      wsUrl: 'ws://127.0.0.1:9/devtools/browser/fake',
      provider: params.provider,
      status: 'ACTIVE',
      startUrl: 'http://127.0.0.1/',
      providerProfileSource: 'user_persistent',
      providerProfilePersist: true,
    },
  });
}

async function cleanup(userId: string): Promise<void> {
  await deleteCloudBrowserSignInEvidence(userId);
  await prisma.browserSession.deleteMany({ where: { context: { userId } } });
  await prisma.browserContext.deleteMany({ where: { userId } });
  await prisma.localStorageOrigin.deleteMany({ where: { userId } });
  await prisma.cookie.deleteMany({ where: { userId } });
  await prisma.cookieBundle.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { userId } });
}

async function verifyHarvestRestoresOnOtherProvider(): Promise<void> {
  const userId = `auth-persist-${randomUUID()}`;
  const fixture = await listen();
  const source = await chromium.launch({ headless: true });
  const steelBrowser = await chromium.launch({ headless: true });
  const nextKernel = await chromium.launch({ headless: true });
  await steelBrowser.newContext();
  await nextKernel.newContext();
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  try {
    const kernelSession = await createSession({
      userId,
      provider: 'kernel',
      sessionId: `kernel-${randomUUID()}`,
    });
    await signIn(source, fixture.origin);
    await recordSignIn(kernelSession, userId, fixture.origin);
    const harvested = await persistSignedInBrowserState(kernelSession.sessionId, {
      browser: source,
    });
    assert(harvested.persisted, `kernel harvest did not persist: ${harvested.reason ?? 'unknown'}`);
    assert(harvested.cookieCount > 0, 'kernel harvest wrote no cookies');
    const cloudBundle = await prisma.cookieBundle.findUniqueOrThrow({
      where: {
        userId_authRealm_browserSource_browserProfile: {
          userId,
          authRealm: '127.0.0.1',
          browserSource: 'kernel',
          browserProfile: CLOUD_PERSISTENT_BROWSER_PROFILE,
        },
      },
    });

    const steelSession = await createSession({
      userId,
      provider: 'steel',
      sessionId: `steel-${randomUUID()}`,
    });
    const steelInjection = await injectUserData(steelSession.sessionId, userId, fixture.origin, {
      browser: steelBrowser,
    });
    assert(
      steelInjection.cookies.injected &&
        steelInjection.cookies.credentialRef?.kind === 'cookie_bundle' &&
        steelInjection.cookies.credentialRef.id === cloudBundle.id,
      `steel inject missed kernel cookies: ${JSON.stringify(steelInjection.cookies)}`
    );
    const steelState = await readSignIn(steelBrowser, fixture.origin);
    assert(
      steelState.cookie.includes('session=signed-in'),
      `steel browser lost the kernel sign-in cookie: ${steelState.cookie}`
    );
    assert(
      steelState.localStorage === 'signed-in',
      `steel browser lost kernel localStorage: ${String(steelState.localStorage)}`
    );

    const laterKernel = await createSession({
      userId,
      provider: 'kernel',
      sessionId: `kernel-later-${randomUUID()}`,
    });
    const laterInjection = await injectUserData(laterKernel.sessionId, userId, fixture.origin, {
      browser: nextKernel,
    });
    assert(
      laterInjection.cookies.injected,
      'later kernel browser-agent call did not inject harvested cookies'
    );
    const laterState = await readSignIn(nextKernel, fixture.origin);
    assert(
      laterState.cookie.includes('session=signed-in') && laterState.localStorage === 'signed-in',
      'later kernel browser-agent call did not restore signed-in state'
    );
  } finally {
    await source.close().catch(() => undefined);
    await steelBrowser.close().catch(() => undefined);
    await nextKernel.close().catch(() => undefined);
    await fixture.close();
    await cleanup(userId);
  }
}

async function verifyAnonymousRealmKeepsUserBrowserBundle(): Promise<void> {
  const userId = `auth-persist-anon-${randomUUID()}`;
  const fixture = await listen();
  const source = await chromium.launch({ headless: true });
  const nextBrowser = await chromium.launch({ headless: true });
  await nextBrowser.newContext();
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  try {
    const macBundle = await prisma.cookieBundle.create({
      data: { userId, authRealm: 'localhost', browserSource: 'chrome', browserProfile: 'Default' },
    });
    await prisma.cookie.create({
      data: {
        userId,
        domain: 'localhost',
        name: 'session',
        path: '/',
        value: 'mac-signed-in',
        browserSource: 'chrome',
        browserProfile: 'Default',
        creationUtc: 13_000_000_000_000_000n,
        hasExpires: false,
        isPersistent: false,
      },
    });
    const kernelSession = await createSession({
      userId,
      provider: 'kernel',
      sessionId: `kernel-anon-${randomUUID()}`,
    });
    await signIn(source, fixture.origin);
    await signIn(source, fixture.localhostOrigin, 'anonymous-visit');
    await recordSignIn(kernelSession, userId, fixture.origin);
    const harvested = await persistSignedInBrowserState(kernelSession.sessionId, {
      browser: source,
    });
    assert(harvested.persisted && harvested.realmCount === 1, JSON.stringify(harvested));
    const anonymousRows = await prisma.cookie.count({
      where: { userId, browserProfile: CLOUD_PERSISTENT_BROWSER_PROFILE, domain: 'localhost' },
    });
    assert(anonymousRows === 0, `anonymous realm was harvested (${anonymousRows} rows)`);

    const nextSession = await createSession({
      userId,
      provider: 'steel',
      sessionId: `steel-anon-${randomUUID()}`,
    });
    const injection = await injectUserData(nextSession.sessionId, userId, fixture.localhostOrigin, {
      browser: nextBrowser,
    });
    assert(
      injection.cookies.credentialRef?.kind === 'cookie_bundle' &&
        injection.cookies.credentialRef.id === macBundle.id,
      `anonymous visit displaced the user's browser bundle: ${JSON.stringify(injection.cookies)}`
    );
    const state = await readSignIn(nextBrowser, fixture.localhostOrigin);
    assert(state.cookie.includes('session=mac-signed-in'), `next session got ${state.cookie}`);
  } finally {
    await source.close().catch(() => undefined);
    await nextBrowser.close().catch(() => undefined);
    await fixture.close();
    await cleanup(userId);
  }
}

/** Chromium prints its bound CDP endpoint once the debugging port is listening. */
function waitForCdpEndpoint(chrome: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      reject(new Error(`Chromium CDP did not start: ${output.slice(-500)}`));
    }, 15_000);
    chrome.stderr?.on('data', (chunk: Buffer) => {
      output = `${output}${chunk.toString()}`.slice(-4_000);
      const endpoint = /DevTools listening on (ws:\/\/\S+)/.exec(output)?.[1];
      if (endpoint !== undefined) {
        clearTimeout(timer);
        resolve(endpoint);
      }
    });
    chrome.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Chromium exited (${code ?? signal}) before CDP: ${output.slice(-500)}`));
    });
  });
}

async function verifyFreshCdpHarvestsSignedInLocalStorage(): Promise<void> {
  const userId = `auth-persist-cdp-${randomUUID()}`;
  const fixture = await listen();
  const userDataDir = await mkdtemp(join(tmpdir(), 'auth-persist-cdp-'));
  const chrome = spawn(
    chromium.executablePath(),
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      `--user-data-dir=${userDataDir}`,
      '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  const cdpEndpoint = waitForCdpEndpoint(chrome);
  cdpEndpoint.catch(() => undefined);
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  try {
    const endpoint = await cdpEndpoint;
    const first = await chromium.connectOverCDP(endpoint);
    try {
      await signIn(first, fixture.origin);
      const signedInPage = first.contexts()[0]?.pages()[0];
      assert(signedInPage !== undefined, 'source browser lost the signed-in page');
      await signedInPage.goto('about:blank');
    } finally {
      await first.close();
    }
    const harvestBrowser = await chromium.connectOverCDP(endpoint);
    try {
      const kernelSession = await createSession({
        userId,
        provider: 'kernel',
        sessionId: `kernel-cdp-${randomUUID()}`,
      });
      await recordSignIn(kernelSession, userId, fixture.origin);
      const harvested = await persistSignedInBrowserState(kernelSession.sessionId, {
        browser: harvestBrowser,
        currentUrl: fixture.origin,
      });
      assert(
        harvested.persisted,
        `fresh CDP harvest did not persist: ${harvested.reason ?? 'unknown'}`
      );
      assert(
        harvested.localStorageOriginCount > 0,
        'fresh CDP harvest missed localStorage after the signed-in tab closed'
      );
      const stored = await prisma.localStorageOrigin.findUnique({
        where: { userId_origin: { userId, origin: fixture.origin } },
      });
      assert(stored !== null, 'fresh CDP harvest wrote no LocalStorageOrigin row');
      const entries = stored.entries as Array<{ key: string; value: string }>;
      assert(
        entries.some((entry) => entry.key === 'rose_handoff' && entry.value === 'signed-in'),
        `fresh CDP harvest wrote ${JSON.stringify(entries)}`
      );
    } finally {
      await harvestBrowser.close().catch(() => undefined);
    }
  } finally {
    if (chrome.pid !== undefined) {
      try {
        process.kill(chrome.pid, 'SIGTERM');
      } catch {
        // Chromium already exited.
      }
    }
    await new Promise<void>((resolve) => {
      if (chrome.exitCode !== null || chrome.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, 2_000);
      chrome.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await fixture.close();
    await cleanup(userId);
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  process.stdout.write('Browser Session Auth Persist Black-box Tests\n');
  await verifyHarvestRestoresOnOtherProvider();
  process.stdout.write(
    '  PASS  persist -- kernel sign-in restores on steel and a later kernel call\n'
  );
  await verifyAnonymousRealmKeepsUserBrowserBundle();
  process.stdout.write(
    '  PASS  persist -- anonymous realm visit keeps the user browser bundle selected\n'
  );
  await verifyFreshCdpHarvestsSignedInLocalStorage();
  process.stdout.write('  PASS  persist -- fresh CDP reconnect harvests signed-in localStorage\n');
  process.stdout.write('All browser-session-auth-persist blackbox tests passed\n');
}

main()
  .catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
