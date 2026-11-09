#!/usr/bin/env tsx
import { verifyInventoryOnly } from './browser-session-inventory-only.cases';

import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { mock } from 'node:test';
import type { Browser, BrowserContext, Page } from 'playwright';
import {
  prepareSessionCredentials,
  SessionCredentialInjectionError,
  SessionNotFoundError,
} from '../../domains/browser-session/service';
import { buildSessionCredentialPayload } from '../../domains/browser-session/service.credential-error';
import { canonicalAuthRealm } from '../../providers/authRealm';
import { resetKernelSessionTabs } from '../../providers/browser/kernel';
import { prisma } from '../../providers/database';
import {
  isOriginPayloadScript,
  mockOriginPayloadSql,
  verifyNativeSqlTimeoutInverses,
} from './browser-session-credential-timeout.cases';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function verifyUnifiedCredentialBoundary(): Promise<void> {
  const userId = `jit-credentials-${randomUUID()}`;
  const otherUserId = `jit-credentials-other-${randomUUID()}`;
  const sessionId = `kernel-session-${randomUUID()}`;
  const browserSource = `chrome-${randomUUID()}`;
  const browserProfile = 'Default';
  let addedCookies: Array<{ name?: string; domain?: string; value?: string }> = [];
  const injectedScripts: string[] = [];
  const injectionEvents: string[] = [];
  let callerBrowserCloseCount = 0;
  let ownedPageCount = 0;
  let ownedPageCloseCount = 0;

  await prisma.user.createMany({
    data: [
      { userId, isAnonymous: true },
      { userId: otherUserId, isAnonymous: true },
    ],
  });
  const context = await prisma.browserContext.create({ data: { userId } });
  const session = await prisma.browserSession.create({
    data: {
      contextId: context.id,
      agentId: randomUUID(),
      sessionId,
      wsUrl: 'ws://credential-boundary.test',
      provider: 'kernel',
      status: 'ACTIVE',
      startUrl: 'https://order.online',
    },
  });
  const cookieBundle = await prisma.cookieBundle.create({
    data: {
      userId,
      authRealm: 'example.co.uk',
      browserSource,
      browserProfile,
      accountLabel: 'UK domain fixture',
    },
  });
  const password = await prisma.browserPassword.create({
    data: {
      userId,
      origin: 'https://www.example.co.uk/login',
      username: 'fixture@example.com',
      encryptedPassword: 'encrypted-password-fixture',
      dateLastUsed: BigInt(Date.now()),
      browserSource,
      browserProfile,
    },
  });
  const passkey = await prisma.passkeyCredential.create({
    data: {
      userId,
      authRealm: 'example.co.uk',
      rpId: 'example.co.uk',
      credentialId: `credential-${randomUUID()}`,
      encryptedPrivateKey: 'encrypted-private-key-fixture',
      userHandle: 'fixture-user-handle',
      signCount: 7,
    },
  });
  await prisma.cookie.create({
    data: {
      userId,
      domain: '.example.co.uk',
      name: 'uk-session',
      value: '',
      browserSource,
      browserProfile,
      creationUtc: BigInt(Date.now()),
    },
  });
  await prisma.cookie.create({
    data: {
      userId,
      domain: '.example.co.uk',
      name: '',
      value: 'invalid-row',
      browserSource,
      browserProfile,
      creationUtc: BigInt(Date.now()),
    },
  });
  await prisma.localStorageOrigin.createMany({
    data: [
      {
        userId,
        origin: 'https://example.co.uk',
        entries: [{ key: 'exact', value: 'allowed' }],
        hash: 'exact-state',
      },
      {
        userId,
        origin: 'https://shop.example.co.uk',
        entries: [{ key: 'subdomain', value: 'allowed' }],
        hash: 'subdomain-state',
      },
      {
        userId,
        origin: 'https://notexample.co.uk',
        entries: [{ key: 'cross-site', value: 'forbidden' }],
        hash: 'cross-site-state',
      },
    ],
  });

  const fakeBrowser = {
    contexts: () => [
      {
        addCookies: async (cookies: Array<{ name?: string; domain?: string; value?: string }>) => {
          injectionEvents.push('cookies');
          addedCookies = cookies;
        },
        addInitScript: async (script: string) => {
          injectionEvents.push('browser-state');
          injectedScripts.push(script);
        },
        newCDPSession: async () => ({ send: async () => undefined }),
        newPage: async () => {
          ownedPageCount += 1;
          let pageUrl = 'about:blank';
          return {
            route: async () => undefined,
            url: () => pageUrl,
            goto: async (url: string) => {
              pageUrl = url;
            },
            evaluate: async (script: string) => {
              injectionEvents.push('browser-state');
              injectedScripts.push(script);
            },
            close: async () => {
              ownedPageCloseCount += 1;
            },
          };
        },
      },
    ],
    close: async () => {
      callerBrowserCloseCount += 1;
    },
  } as unknown as Browser;

  try {
    await verifyInventoryOnly({
      sessionId,
      userId,
      otherUserId,
      passwordId: password.id,
      passkeyId: passkey.id,
      browser: fakeBrowser,
      injectionCount: () => injectionEvents.length,
    });
    const result = await prepareSessionCredentials(
      sessionId,
      userId,
      'https://www.example.co.uk/store/example',
      { browser: fakeBrowser }
    );
    assert(result.auth_realm === 'example.co.uk', 'expected canonical UK auth realm');
    assert(result.auth_credential_ref?.id === cookieBundle.id, 'expected selected cookie bundle');
    assert(result.cookies_injected === true && result.cookies_count === 1, 'cookie not injected');
    assert(addedCookies.length === 1, 'invalid cookie row was not filtered');
    assert(addedCookies[0]?.name === 'uk-session', 'wrong cookie injected');
    assert(addedCookies[0]?.value === '', 'valid empty cookie value was filtered out');
    assert(injectionEvents[0] === 'cookies', 'browser state mutated before cookie injection');
    assert(callerBrowserCloseCount === 0, 'caller-owned browser connection was closed');
    assert(
      ownedPageCount > 0 && ownedPageCloseCount === ownedPageCount,
      'owned credential restoration page was not closed'
    );
    assert(
      result.passwords.length === 1 && result.passwords[0]?.id === password.id,
      'realm password missing from unified payload'
    );
    assert(
      result.passkeys.length === 1 && result.passkeys[0]?.id === passkey.id,
      'realm passkey missing from unified payload'
    );
    assert(
      result.auth_options.passwords.some((item) => item.id === password.id && !item.disabled),
      'enabled password missing from auth options'
    );
    assert(
      result.auth_options.passkeys.some((item) => item.id === passkey.id && !item.disabled),
      'enabled passkey missing from auth options'
    );
    assert(
      result.browser_state_injection.localStorage.originCount === 2,
      'expected only exact and dot-boundary subdomain state'
    );
    const allScripts = injectedScripts.join('\n');
    assert(allScripts.includes('https://example.co.uk'), 'exact-origin state was not prepared');
    assert(
      allScripts.includes('https://shop.example.co.uk'),
      'valid subdomain state was not prepared'
    );
    assert(
      !allScripts.includes('https://notexample.co.uk'),
      'cross-site co.uk state crossed the credential boundary'
    );
    assert(
      !allScripts.includes('origin.includes') && !allScripts.includes('currentOrigin.includes'),
      'injected state still uses substring origin matching'
    );

    const previousTimeout = process.env.BROWSER_STATE_INJECTION_TIMEOUT_MS;
    let releasePendingScript: (() => void) | undefined;
    let pendingScriptCalls = 0;
    let pendingPageClosed = false;
    let unrelatedInitCalls = 0;
    const originRows = await prisma.localStorageOrigin.findMany({ where: { userId } });
    const sqlTransport = mockOriginPayloadSql(originRows);
    let signalPendingScript: (() => void) | undefined;
    const pendingScriptStarted = new Promise<void>((resolve) => {
      signalPendingScript = resolve;
    });
    const pendingScript = new Promise<void>((resolve) => {
      releasePendingScript = resolve;
    });
    const timeoutBrowser = {
      contexts: () => [
        {
          ...fakeBrowser.contexts()[0],
          newPage: async () => {
            const page = await fakeBrowser.contexts()[0].newPage();
            return {
              ...page,
              evaluate: async (script: string) => {
                assert(
                  isOriginPayloadScript(script) && script.includes('allowed'),
                  'pending callback is not the fixture origin payload'
                );
                pendingScriptCalls += 1;
                signalPendingScript?.();
                await pendingScript;
              },
              close: async () => {
                if (!pendingPageClosed) {
                  pendingPageClosed = true;
                  await page.close();
                }
              },
            };
          },
          addInitScript: async (script: string) => {
            assert(
              !isOriginPayloadScript(script),
              'origin payload unexpectedly used unrelated initScript channel'
            );
            unrelatedInitCalls += 1;
          },
        },
      ],
      close: async () => {
        callerBrowserCloseCount += 1;
      },
    } as unknown as Browser;
    await timeoutBrowser.contexts()[0].addInitScript('unrelated scrollbar fixture');
    assert(
      unrelatedInitCalls === 1 && pendingScriptCalls === 0,
      'unrelated init script satisfied origin barrier'
    );
    unrelatedInitCalls = 0;
    process.env.BROWSER_STATE_INJECTION_TIMEOUT_MS = '25';
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let injectionError: unknown;
      let preparationSettled = false;
      const preparation = prepareSessionCredentials(
        sessionId,
        userId,
        'https://shop.example.co.uk/login',
        { browser: timeoutBrowser }
      ).then(
        () => {
          preparationSettled = true;
        },
        (error: unknown) => {
          preparationSettled = true;
          injectionError = error;
        }
      );
      // Select the CDP phase explicitly; SQL staging shares the same budget.
      await Promise.race([
        pendingScriptStarted,
        preparation.then(() => {
          throw new Error('preparation settled before pending origin payload');
        }),
      ]);
      mock.timers.tick(24);
      await Promise.resolve();
      assert(!preparationSettled, 'state injection expired before its exact budget');
      mock.timers.tick(1);
      await preparation;
      assert(injectionError instanceof Error, 'state timeout did not reject preparation');
      assert(
        injectionError.message === 'Browser state injection timed out after 25ms',
        'preparation did not preserve the exact state timeout'
      );
      assert(
        pendingScriptCalls === 1,
        'timeout did not exercise the pending origin payload evaluation'
      );
      assert(
        'credentialPayload' in injectionError,
        'state timeout discarded the validated target credential payload'
      );
      assert(
        'code' in injectionError && injectionError.code === 'BROWSER_CREDENTIAL_INJECTION_FAILED',
        'state timeout did not carry the precise injection failure tag'
      );
      assert(
        injectionError instanceof SessionCredentialInjectionError &&
          injectionError.cause instanceof Error &&
          injectionError.cause.message === injectionError.message,
        'injection wrapper did not preserve the typed error and original cause'
      );
      assert(
        !inspect(injectionError).includes('encrypted-password-fixture') &&
          !inspect(injectionError).includes('encrypted-private-key-fixture'),
        'ordinary error inspection exposes credential material'
      );
      const payload = injectionError.credentialPayload as Pick<
        typeof result,
        'auth_realm' | 'auth_options' | 'passwords' | 'passkeys'
      >;
      assert(payload.auth_realm === 'example.co.uk', 'timeout payload has the wrong target realm');
      assert(
        payload.auth_options.realm === 'example.co.uk',
        'timeout auth options have wrong realm'
      );
      assert(
        payload.passwords.length === 1 && payload.passwords[0]?.id === password.id,
        'timeout payload lost the target password reference'
      );
      assert(
        payload.passkeys.length === 1 && payload.passkeys[0]?.id === passkey.id,
        'timeout payload lost the target passkey reference'
      );
      assert(
        payload.auth_options.passwords.some((item) => item.id === password.id && !item.disabled) &&
          payload.auth_options.passkeys.some((item) => item.id === passkey.id && !item.disabled),
        'timeout payload lost complete enabled credential options'
      );
      assert(
        Object.keys(payload).sort().join(',') === 'auth_options,auth_realm,passkeys,passwords',
        'timeout payload includes applied-cookie or restoration claims'
      );
      assert(callerBrowserCloseCount === 0, 'timeout closed the caller-owned browser');
      console.log(
        'PASS origin payload entered; state timeout rejects and preserves complete target credential inventory'
      );
    } finally {
      if (previousTimeout === undefined) delete process.env.BROWSER_STATE_INJECTION_TIMEOUT_MS;
      else process.env.BROWSER_STATE_INJECTION_TIMEOUT_MS = previousTimeout;
      releasePendingScript?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
      mock.timers.reset();
      sqlTransport.mock.restore();
    }
    assert(pendingPageClosed, 'timeout did not dispose its owned origin page');
    assert(unrelatedInitCalls === 0, 'timeout reached unrelated init scripts');
    assert(pendingScriptCalls === 1, 'timeout allowed later browser-state mutations');
    await verifyNativeSqlTimeoutInverses(sessionId, userId);

    const bestEffortBrowser = {
      contexts: () => [
        {
          addCookies: async () => undefined,
          addInitScript: async () => undefined,
          newPage: async () => {
            throw new Error('best-effort browser state failed');
          },
        },
      ],
      close: async () => undefined,
    } as unknown as Browser;
    const bestEffortResult = await prepareSessionCredentials(
      sessionId,
      userId,
      'https://www.example.co.uk/store/example',
      { browser: bestEffortBrowser }
    );
    assert(bestEffortResult.cookies_injected, 'cookie injection did not survive state failure');
    assert(
      !bestEffortResult.browser_state_injection.localStorage.injected,
      'failed best-effort localStorage was reported as injected'
    );

    const serviceSource = prepareSessionCredentials.toString();
    const completenessCheck = serviceSource.indexOf('buildSessionCredentialPayload');
    const browserInjection = serviceSource.indexOf('injectUserData', completenessCheck);
    assert(
      buildSessionCredentialPayload.toString().includes('missingPasswordIds.length'),
      'credential payload completeness validation is missing'
    );
    assert(completenessCheck > 0, 'credential completeness check is missing');
    assert(
      browserInjection > completenessCheck,
      'browser state injection runs before credential completeness validation'
    );

    // Auth-cookie selection ignores nameless rows, so a bundle that only has
    // empty-name cookies is treated as empty credentials (soft-skip), not as a
    // hard injection failure — same outcome as no matching auth cookies.
    await prisma.cookie.deleteMany({ where: { userId, name: { not: '' } } });
    const namelessOnlyResult = await prepareSessionCredentials(
      sessionId,
      userId,
      'https://www.example.co.uk/store/example',
      { browser: fakeBrowser }
    );
    assert(
      namelessOnlyResult.auth_source === 'none' &&
        namelessOnlyResult.auth_credential_ref === null &&
        namelessOnlyResult.cookies_count === 0,
      'credential boundary accepted only invalid cookie rows'
    );
    assert(callerBrowserCloseCount === 0, 'nameless-only soft-skip closed caller-owned browser');

    await prisma.cookie.deleteMany({ where: { userId } });
    const emptyCookieBundleResult = await prepareSessionCredentials(
      sessionId,
      userId,
      'https://www.example.co.uk/store/example',
      { browser: fakeBrowser }
    );
    assert(
      emptyCookieBundleResult.auth_source === 'none' &&
        emptyCookieBundleResult.auth_credential_ref === null &&
        emptyCookieBundleResult.cookies_count === 0,
      'credential boundary selected a cookie bundle with no matching cookie rows'
    );
    assert(
      callerBrowserCloseCount === 0,
      'skipping an empty cookie bundle closed the caller-provided browser'
    );

    let rejectedWrongOwner = false;
    try {
      await prepareSessionCredentials(sessionId, otherUserId, 'https://www.example.co.uk');
    } catch (error) {
      assert(error instanceof SessionNotFoundError, 'wrong owner lost its not-found error');
      assert(!('credentialPayload' in error), 'wrong owner received a credential payload');
      rejectedWrongOwner = true;
    }
    assert(rejectedWrongOwner, 'credential boundary accepted a session owned by another user');
  } finally {
    await prisma.browserSession.deleteMany({ where: { id: session.id } });
    await prisma.browserContext.deleteMany({ where: { id: context.id } });
    await prisma.passkeyCredential.deleteMany({ where: { userId } });
    await prisma.browserPassword.deleteMany({ where: { userId } });
    await prisma.cookie.deleteMany({ where: { userId } });
    await prisma.cookieBundle.deleteMany({ where: { userId } });
    await prisma.localStorageOrigin.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
  }
}

async function main(): Promise<void> {
  assert(
    canonicalAuthRealm('https://www.doordash.com/store/example') === 'doordash.com',
    'www DoorDash URL did not resolve to the saved doordash.com auth realm'
  );
  assert(
    canonicalAuthRealm('https://identity.doordash.com/login') === 'doordash.com',
    'non-www DoorDash subdomain did not resolve to the saved base realm'
  );
  assert(
    canonicalAuthRealm('https://shop.example.co.uk/checkout') === 'example.co.uk',
    'multi-label public suffix did not resolve with PSL semantics'
  );
  assert(
    canonicalAuthRealm('about:blank') === '',
    'about:blank unexpectedly resolved to an auth realm'
  );
  assert(
    canonicalAuthRealm('file:///tmp/page.html') === '',
    'file URL unexpectedly resolved to an auth realm'
  );
  assert(
    canonicalAuthRealm('http://localhost:3000/?authRealm=doordash.com') === 'doordash.com',
    'backend did not honor the worker-compatible local authRealm override'
  );
  assert(canonicalAuthRealm('localhost:3000') === 'localhost', 'raw host:port was rejected');
  assert(
    canonicalAuthRealm('https://localhost.evil.com/?authRealm=doordash.com') === 'evil.com',
    'backend trusted an authRealm override from a lookalike localhost domain'
  );
  assert(
    canonicalAuthRealm('https://anyone.loca.lt/?authRealm=doordash.com') !== 'doordash.com',
    'backend trusted an authRealm override from a public localtunnel origin no dev stack serves'
  );

  await verifyUnifiedCredentialBoundary();

  let contextAlive = true;
  let openPages = 1;

  const restoredPage = {
    close: async () => {
      openPages -= 1;
      if (openPages === 0) contextAlive = false;
    },
  } as Page;

  const context = {
    pages: () => (openPages > 0 ? [restoredPage] : []),
    newPage: async () => {
      openPages += 1;
      contextAlive = true;
      return {} as Page;
    },
  } as BrowserContext;

  const browser = {
    contexts: () => (contextAlive ? [context] : []),
  } as Browser;

  const closed = await resetKernelSessionTabs(browser);

  assert(closed === 1, `expected one restored tab closed, got ${closed}`);
  assert(browser.contexts()[0] !== undefined, 'cookie injection lost its browser context');
  assert(
    browser.contexts()[0]?.pages().length === 1,
    'expected one clean bootstrap tab to retain the browser context'
  );
  console.log('PASS Kernel tab reset retains a CDP context for credential injection');
  console.log('PASS unified realm boundary injects cookies and returns passwords/passkeys');
  await prisma.$disconnect();
}

void main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
