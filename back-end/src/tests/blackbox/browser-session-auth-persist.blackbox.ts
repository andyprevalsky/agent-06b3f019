#!/usr/bin/env tsx
/**
 * Signed-in Kernel/Steel state must survive session close and land on the
 * other provider (and on a later browser-agent call) via CookieBundle inject.
 */
import { createServer, type AddressInfo } from 'node:http';
import { randomUUID } from 'node:crypto';
import { chromium, type Browser } from 'playwright';
import { prisma } from '../../providers/database';
import { persistSignedInBrowserState } from '../../providers/browser/sessionAuthPersist';
import { injectUserData } from '../../providers/steel/injection';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function listen(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<body>auth persist fixture</body>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function signIn(browser: Browser, origin: string): Promise<void> {
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    document.cookie = 'session=signed-in; path=/';
    localStorage.setItem('rose_handoff', 'signed-in');
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
    const harvested = await persistSignedInBrowserState(kernelSession.sessionId, {
      browser: source,
    });
    assert(harvested.persisted, `kernel harvest did not persist: ${harvested.reason ?? 'unknown'}`);
    assert(harvested.cookieCount > 0, 'kernel harvest wrote no cookies');

    const steelSession = await createSession({
      userId,
      provider: 'steel',
      sessionId: `steel-${randomUUID()}`,
    });
    const steelInjection = await injectUserData(steelSession.sessionId, userId, fixture.origin, {
      browser: steelBrowser,
    });
    assert(
      steelInjection.cookies.injected && steelInjection.cookies.authSource === 'cookie_bundle',
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

async function main(): Promise<void> {
  process.stdout.write('Browser Session Auth Persist Black-box Tests\n');
  await verifyHarvestRestoresOnOtherProvider();
  process.stdout.write(
    '  PASS  persist -- kernel sign-in restores on steel and a later kernel call\n'
  );
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
