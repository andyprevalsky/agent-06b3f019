#!/usr/bin/env tsx

import { randomUUID } from 'node:crypto';
import type { Browser, BrowserContext, Page } from 'playwright';
import { prepareSessionCredentials } from '../../domains/browser-session/service';
import { canonicalAuthRealm } from '../../providers/authRealm';
import { resetKernelSessionTabs } from '../../providers/browser/kernel';
import { prisma } from '../../providers/database';

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
          addedCookies = cookies;
        },
        addInitScript: async (script: string) => {
          injectedScripts.push(script);
        },
      },
    ],
    close: async () => undefined,
  } as unknown as Browser;

  try {
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

    const bestEffortBrowser = {
      contexts: () => [
        {
          addCookies: async () => undefined,
          addInitScript: async () => {
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
    const completenessCheck = serviceSource.indexOf('missingPasswordIds.length');
    const browserInjection = serviceSource.indexOf('injectUserData', completenessCheck);
    assert(completenessCheck > 0, 'credential completeness check is missing');
    assert(
      browserInjection > completenessCheck,
      'browser state injection runs before credential completeness validation'
    );

    await prisma.cookie.deleteMany({ where: { userId, name: { not: '' } } });
    let rejectedAllInvalidCookies = false;
    try {
      await prepareSessionCredentials(
        sessionId,
        userId,
        'https://www.example.co.uk/store/example',
        { browser: fakeBrowser }
      );
    } catch (error) {
      rejectedAllInvalidCookies =
        error instanceof AggregateError &&
        error.errors.some((innerError) =>
          String(innerError?.cause ?? innerError).includes('without a name')
        );
    }
    assert(rejectedAllInvalidCookies, 'credential boundary accepted only invalid cookie rows');

    await prisma.cookie.deleteMany({ where: { userId } });
    let rejectedEmptyCookieBundle = false;
    try {
      await prepareSessionCredentials(
        sessionId,
        userId,
        'https://www.example.co.uk/store/example',
        { browser: fakeBrowser }
      );
    } catch (error) {
      rejectedEmptyCookieBundle = String(error).includes('contains no cookie rows');
    }
    assert(
      rejectedEmptyCookieBundle,
      'credential boundary accepted a selected cookie bundle with no cookie rows'
    );

    let rejectedWrongOwner = false;
    try {
      await prepareSessionCredentials(sessionId, otherUserId, 'https://www.example.co.uk');
    } catch {
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
