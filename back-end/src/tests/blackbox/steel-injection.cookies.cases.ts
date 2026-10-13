import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { prisma } from '../../providers/database';
import {
  injectUserData,
  resolveBrowserAuthCredentialSource,
} from '../../providers/steel/injection';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface CookieBundleFixtureParams {
  userId: string;
  browserProfile: string;
  creationUtc: bigint;
  authRealm?: string;
  includeCookie?: boolean;
}

export function registerCookieTransferCases(
  test: (name: string, fn: () => Promise<void>) => void,
  fixtures: {
    createUser: () => Promise<string>;
    cleanup: (userId: string) => Promise<void>;
    createCookieBundle: (params: CookieBundleFixtureParams) => Promise<{ id: string }>;
  }
): void {
  const { createUser, cleanup, createCookieBundle } = fixtures;
  test('Google bundle ranking ignores newer cookies from other SSO realms', async () => {
    const userId = await createUser();
    try {
      // Metadata from agent 07281fc3's start fixture. Cookie values are synthetic.
      const newestGoogle = await createCookieBundle({
        userId,
        authRealm: 'google.com',
        browserProfile: 'Default',
        includeCookie: false,
        creationUtc: 0n,
      });
      await createCookieBundle({
        userId,
        authRealm: 'google.com',
        browserProfile: 'Profile 1',
        includeCookie: false,
        creationUtc: 0n,
      });
      await prisma.cookie.createMany({
        data: [
          {
            domain: '.play.google.com',
            name: 'PLAY_ACTIVE_ACCOUNT',
            browserProfile: 'Default',
            creationUtc: 13436237732148350n,
          },
          {
            domain: 'accounts.google.com',
            name: 'ACCOUNT_CHOOSER',
            browserProfile: 'Profile 1',
            creationUtc: 13435791376488668n,
          },
          {
            domain: 'github.com',
            name: '_gh_sess',
            browserProfile: 'Profile 1',
            creationUtc: 13436249998674776n,
          },
        ].map((row) => ({
          ...row,
          userId,
          browserSource: 'chrome',
          value: 'synthetic',
          hasExpires: false,
        })),
      });
      const selected = await resolveBrowserAuthCredentialSource({
        userId,
        authRealm: 'google.com',
        steelContextId: null,
      });
      assert(
        selected.kind === 'cookie_bundle' && selected.id === newestGoogle.id,
        `Google bundle ranked by another realm: ${selected.kind === 'cookie_bundle' ? selected.browserProfile : selected.kind}`
      );
    } finally {
      await cleanup(userId);
    }
  });

  test('expired auth cookies cannot make a bundle win selection', async () => {
    const userId = await createUser();
    try {
      const live = await createCookieBundle({ userId, browserProfile: 'Live', creationUtc: 1000n });
      await createCookieBundle({ userId, browserProfile: 'Expired', creationUtc: 2000n });
      await prisma.cookie.updateMany({
        where: { userId, browserProfile: 'Live' },
        data: { expiresUtc: 0n, hasExpires: false },
      });
      await prisma.cookie.updateMany({
        where: { userId, browserProfile: 'Expired' },
        data: { expiresUtc: 11644473601000000n, hasExpires: true },
      });
      const selected = await resolveBrowserAuthCredentialSource({
        userId,
        authRealm: 'amazon.com',
        steelContextId: null,
      });
      assert(
        selected.kind === 'cookie_bundle' && selected.id === live.id,
        'expired auth cookies displaced a live bundle'
      );
    } finally {
      await cleanup(userId);
    }
  });

  test('cookie transfer preserves browser SameSite and expiry semantics', async () => {
    const userId = await createUser();
    const browser = await chromium.launch({ headless: true });
    const browserContext = await browser.newContext();
    const context = await prisma.browserContext.create({ data: { userId } });
    const sessionId = `cookie-transfer-${randomUUID()}`;
    try {
      await prisma.browserSession.create({
        data: {
          contextId: context.id,
          agentId: randomUUID(),
          sessionId,
          wsUrl: 'ws://already-connected.invalid',
          provider: 'kernel',
          startUrl: 'https://google.com',
        },
      });
      await createCookieBundle({
        userId,
        authRealm: 'google.com',
        browserProfile: 'Default',
        includeCookie: false,
        creationUtc: 0n,
      });
      await prisma.cookie.createMany({
        data: [
          { name: 'session_none', sameSite: 0, expiresUtc: 0n, hasExpires: false },
          { name: 'session_strict', sameSite: 2, expiresUtc: 0n, hasExpires: false },
          {
            name: 'session_expired',
            sameSite: 1,
            expiresUtc: 11644473601000000n,
            hasExpires: true,
          },
        ].map((row) => ({
          ...row,
          userId,
          domain: '.google.com',
          value: 'synthetic',
          browserSource: 'chrome',
          browserProfile: 'Default',
          isSecure: true,
          isHttpOnly: true,
          creationUtc: 1000n,
        })),
      });
      await injectUserData(sessionId, userId, 'https://google.com', { browser });
      const cookies = await browserContext.cookies();
      const none = cookies.find((cookie) => cookie.name === 'session_none');
      const strict = cookies.find((cookie) => cookie.name === 'session_strict');
      const violations = [
        ...(none?.sameSite === 'None' ? [] : [`SameSite=None became ${none?.sameSite}`]),
        ...(strict?.sameSite === 'Strict' ? [] : [`SameSite=Strict became ${strict?.sameSite}`]),
        ...(cookies.some((cookie) => cookie.name === 'session_expired')
          ? ['expired cookie revived']
          : []),
      ];
      assert(violations.length === 0, violations.join('; '));
      assert(none?.httpOnly && none.secure && none.expires === -1, 'session cookie flags changed');
    } finally {
      await browser.close();
      await prisma.browserSession.deleteMany({ where: { sessionId } });
      await prisma.browserContext.deleteMany({ where: { id: context.id } });
      await cleanup(userId);
    }
  });
}
