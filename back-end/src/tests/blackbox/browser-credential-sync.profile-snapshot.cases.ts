import { prisma } from '../../providers/database';
import { processCookiesUpload } from '../../domains/integrations/uploadService.browser';
import { getAuthenticatedDomains } from '../../domains/integrations/repo';
import { resolveBrowserAuthCredentialSource } from '../../providers/steel/injection';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Chrome cookie time (microseconds since 1601-01-01) for an epoch-ms instant. */
function chromeTime(epochMs: number): string {
  return (BigInt(epochMs) * 1000n + 11_644_473_600_000_000n).toString();
}

/**
 * One cookie in the Mac app's upload shape. `browserProfile: undefined` is the
 * pre-profile Chrome uploader, which sent no profile and stored rows under ''.
 */
function chromeUpload(params: {
  name: string;
  domain: string;
  browserProfile: string | undefined;
  createdMs: number;
  expiresMs: number | null;
}) {
  const created = chromeTime(params.createdMs);
  return {
    name: params.name,
    value: `synthetic-${params.name}`,
    domain: params.domain,
    host_key: params.domain,
    path: '/',
    top_frame_site_key: '',
    ...(params.browserProfile === undefined ? {} : { browserProfile: params.browserProfile }),
    creation_utc: created,
    last_access_utc: created,
    last_update_utc: created,
    expires_utc: params.expiresMs === null ? '0' : chromeTime(params.expiresMs),
    has_expires: params.expiresMs !== null,
    is_persistent: params.expiresMs !== null,
    is_secure: true,
    is_httponly: false,
    priority: 1,
    samesite: 0,
    source_scheme: 2,
    source_port: 443,
  };
}

const DAY_MS = 86_400_000;

/**
 * Production shape (user 1f85ff25, 2026-11-08): a pre-profile Chrome upload of
 * 2026-05-03 left www.opentable.com `ha_userSession` (a browser-session cookie,
 * no expiry, created the same second as the anonymous `otuvid` visitor id) under
 * browserProfile ''. Since 2026-10-26 the Mac app tags every Chrome cookie with
 * its profile; Profile 1's current opentable.com jar holds only bot-manager,
 * consent and visitor cookies. The profile-less rows were never retired, so
 * opentable.com was reported authenticated from a six-month-old session cookie
 * that Chrome no longer holds.
 */
function legacyProfileLessOpenTableJar(nowMs: number) {
  const visitMs = nowMs - 190 * DAY_MS;
  return [
    chromeUpload({
      name: 'ha_userSession',
      domain: 'www.opentable.com',
      browserProfile: undefined,
      createdMs: visitMs,
      expiresMs: null,
    }),
    chromeUpload({
      name: 'OT-SessionId',
      domain: '.opentable.com',
      browserProfile: undefined,
      createdMs: visitMs,
      expiresMs: visitMs + 30 * 60_000,
    }),
    chromeUpload({
      name: 'otuvid',
      domain: '.opentable.com',
      browserProfile: undefined,
      createdMs: visitMs,
      expiresMs: visitMs + 365 * DAY_MS,
    }),
  ];
}

function currentProfile1OpenTableJar(nowMs: number) {
  const visitMs = nowMs - 9 * DAY_MS;
  return ['_abck', 'bm_s', 'OptanonConsent', 'otuvid'].map((name) =>
    chromeUpload({
      name,
      domain: '.opentable.com',
      browserProfile: 'Profile 1',
      createdMs: visitMs,
      expiresMs: visitMs + 365 * DAY_MS,
    })
  );
}

export function registerProfileSnapshotCases(
  test: (name: string, fn: () => Promise<void>) => void,
  fixtures: { createUser: () => Promise<string>; cleanup: (userId: string) => Promise<void> }
): void {
  const { createUser, cleanup } = fixtures;
  test('profile-aware chrome upload retires the superseded profile-less snapshot', async () => {
    const userId = await createUser();
    const nowMs = Date.now();
    try {
      await processCookiesUpload(userId, legacyProfileLessOpenTableJar(nowMs), 'chrome');
      await processCookiesUpload(
        userId,
        [
          ...currentProfile1OpenTableJar(nowMs),
          chromeUpload({
            name: 'user_session',
            domain: '.github.com',
            browserProfile: 'Default',
            createdMs: nowMs - DAY_MS,
            expiresMs: nowMs + 30 * DAY_MS,
          }),
        ],
        'chrome'
      );

      const profileLessCookies = await prisma.cookie.findMany({
        where: { userId, browserSource: 'chrome', browserProfile: '' },
        select: { domain: true, name: true },
      });
      const profileLessBundles = await prisma.cookieBundle.count({
        where: { userId, browserSource: 'chrome', browserProfile: '' },
      });
      const advertised = await getAuthenticatedDomains(userId);
      const injection = await resolveBrowserAuthCredentialSource({
        userId,
        authRealm: 'opentable.com',
        steelContextId: null,
      });

      assert(
        profileLessCookies.length === 0,
        `expected the profile-less chrome snapshot to be retired once Chrome uploads by profile, still stored: ${profileLessCookies
          .map((row) => `${row.domain}/${row.name}`)
          .join(', ')}`
      );
      assert(
        profileLessBundles === 0,
        'expected the profile-less chrome CookieBundle to be retired'
      );
      assert(
        !advertised.includes('opentable.com'),
        'opentable.com is advertised as authenticated from a cookie Chrome no longer holds'
      );
      assert(
        injection.kind === 'none',
        `expected no opentable.com credential, got ${injection.kind} (stale profile-less bundle)`
      );
      assert(advertised.includes('github.com'), 'expected the current Default session to stay');
    } finally {
      await cleanup(userId);
    }
  });

  test('a live login cookie in the current chrome profile is advertised and injected', async () => {
    const userId = await createUser();
    const nowMs = Date.now();
    try {
      await processCookiesUpload(userId, legacyProfileLessOpenTableJar(nowMs), 'chrome');
      await processCookiesUpload(
        userId,
        [
          ...currentProfile1OpenTableJar(nowMs),
          chromeUpload({
            name: 'login_session',
            domain: '.opentable.com',
            browserProfile: 'Profile 1',
            createdMs: nowMs - DAY_MS,
            expiresMs: nowMs + 30 * DAY_MS,
          }),
        ],
        'chrome'
      );

      const advertised = await getAuthenticatedDomains(userId);
      const injection = await resolveBrowserAuthCredentialSource({
        userId,
        authRealm: 'opentable.com',
        steelContextId: null,
      });

      assert(advertised.includes('opentable.com'), 'expected opentable.com to be advertised');
      assert(
        injection.kind === 'cookie_bundle' && injection.browserProfile === 'Profile 1',
        `expected the Profile 1 opentable.com bundle to be injected, got ${injection.kind}`
      );
    } finally {
      await cleanup(userId);
    }
  });
}
