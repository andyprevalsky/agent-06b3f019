/**
 * The live auth-persist fixture reads and writes its example.com sign-in state
 * in real Chromium whose only egress is a proxy that refuses every CONNECT, as
 * a residential exit did (net::ERR_TUNNEL_CONNECTION_FAILED at
 * https://example.com/, PR #1975 live probes). Sign-in state lives in the
 * browser's own cookie jar and origin storage, so reading or writing it must not
 * depend on the exit reaching the live site.
 *
 *   Chromium ──CONNECT example.com:443──► refusing proxy ──► 502 (tunnel failed)
 *      │
 *      └─ fixture origin read/sign-in ──► synthetic exact-origin document (no CONNECT)
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright';
import { assert, navigateKernelPage } from './browser-provider.helpers';
import { readTargetOriginState, signInOnTargetOrigin } from './browser-provider.auth-persist.live';
import { assertAuthPersistFailedInitCustody } from './browser-provider.auth-persist.cleanup.support';

const TUNNEL_FAILURE = 'net::ERR_TUNNEL_CONNECTION_FAILED';
const TARGET_TUNNEL = 'example.com:443';
const GUARD_COOKIE = 'rose_fixture_auth_guard=independent-fixture';

interface RefusingExit {
  browser: Browser;
  connects: string[];
  close(): Promise<void>;
}

/** Chromium whose proxy answers every CONNECT with 502, like a refusing residential exit. */
async function launchBehindRefusingExit(): Promise<RefusingExit> {
  const connects: string[] = [];
  const proxy: Server = createServer((_request, response) => {
    response.writeHead(502).end();
  });
  proxy.on('connect', (request, socket) => {
    connects.push(String(request.url));
    socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const { port } = proxy.address() as AddressInfo;
  try {
    const browser = await chromium.launch({
      headless: true,
      args: [`--proxy-server=http://127.0.0.1:${port}`],
    });
    return {
      browser,
      connects,
      close: async () => {
        await browser.close().catch(() => undefined);
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
      },
    };
  } catch (error) {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    throw error;
  }
}

/** The fixture itself: the refusing exit fails a real navigation exactly as live did. */
async function assertRefusingExitFailsLiveNavigation(): Promise<void> {
  const exit = await launchBehindRefusingExit();
  try {
    const page = await exit.browser.newPage();
    let failure = '';
    try {
      await navigateKernelPage(page, 'https://example.com');
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    assert(
      failure.includes(`page.goto: ${TUNNEL_FAILURE} at https://example.com/`),
      `expected the live tunnel failure, got: ${failure || 'a successful navigation'}`
    );
    assert(
      exit.connects.includes(TARGET_TUNNEL),
      `the navigation did not use the refusing exit: ${JSON.stringify(exit.connects)}`
    );
  } finally {
    await exit.close();
  }
}

async function assertSignInStateNeedsNoTunnel(): Promise<void> {
  const exit = await launchBehindRefusingExit();
  try {
    const context = await exit.browser.newContext();
    // The provider injects the independent guard cookie before the fixture reads it.
    await context.addCookies([
      { name: 'rose_fixture_auth_guard', value: 'independent-fixture', url: 'https://example.com' },
      { name: 'other_site', value: 'must-not-leak', url: 'https://other.example.net' },
    ]);
    const before = await readTargetOriginState(context);
    const beforeCookies = before.cookie.split(';').map((cookie) => cookie.trim());
    assert(beforeCookies.includes(GUARD_COOKIE), `guard cookie not read: ${before.cookie}`);
    assert(!beforeCookies.includes('session=signed-in'), 'sign-in cookie present before sign-in');
    assert(
      !before.cookie.includes('other_site'),
      `another site's cookie leaked into example.com: ${before.cookie}`
    );
    assert(before.storage === null, `localStorage present before sign-in: ${before.storage}`);

    await signInOnTargetOrigin(context);
    // /close harvests the signed-in tab from the open page, as it would a user's.
    assert(
      context.pages().some((page) => new URL(page.url()).origin === 'https://example.com'),
      `no open example.com tab after sign-in: ${JSON.stringify(context.pages().map((p) => p.url()))}`
    );
    const after = await readTargetOriginState(context);
    assert(after.cookie.includes('session=signed-in'), `sign-in cookie not read: ${after.cookie}`);
    assert(after.storage === 'signed-in', `sign-in localStorage not read: ${after.storage}`);
    // Persistence harvests the browser's stores, not the page: the sign-in must land there.
    const jar = await context.cookies('https://example.com');
    assert(
      jar.some(
        (cookie) => cookie.name === 'session' && cookie.value === 'signed-in' && cookie.path === '/'
      ),
      `sign-in cookie missing from the cookie jar: ${JSON.stringify(jar.map((c) => c.name))}`
    );
    const origins = (await context.storageState()).origins;
    assert(
      origins.some(
        (origin) =>
          origin.origin === 'https://example.com' &&
          origin.localStorage.some(
            (entry) => entry.name === 'rose_handoff' && entry.value === 'signed-in'
          )
      ),
      `sign-in localStorage missing from origin storage: ${JSON.stringify(origins)}`
    );

    // A browser without the restored state must read as signed out.
    const fresh = await exit.browser.newContext();
    const unrestored = await readTargetOriginState(fresh);
    assert(
      !unrestored.cookie.includes('session=signed-in') && unrestored.storage === null,
      `an unrestored browser read as signed in: ${JSON.stringify(unrestored)}`
    );
    // Chromium may tunnel its own background traffic; the target site never.
    assert(
      !exit.connects.includes(TARGET_TUNNEL),
      `sign-in state access opened an example.com tunnel: ${JSON.stringify(exit.connects)}`
    );
  } finally {
    await exit.close();
  }
}

export const authPersistFixtureCases: Array<[string, () => Promise<void>]> = [
  [
    'auth-persist failed-init cleanup discovers owned allocations and retains recovery custody',
    assertAuthPersistFailedInitCustody,
  ],
  [
    'auth-persist refusing-exit fixture fails a live navigation with the tunnel error',
    assertRefusingExitFailsLiveNavigation,
  ],
  [
    'auth-persist sign-in state is read and written without a proxy tunnel',
    assertSignInStateNeedsNoTunnel,
  ],
];
