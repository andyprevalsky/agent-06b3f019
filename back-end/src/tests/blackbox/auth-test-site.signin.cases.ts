/**
 * Rose Shop sign-in cases: saved sessions, passkeys, lockout, second factor,
 * and the code / link / text variants. Each drives the in-process site the way
 * a browser would and then reads the site's own report.
 */

import { runInNewContext } from 'node:vm';
import { prisma } from '../../providers/database';
import { cookieDomainForStartUrl } from '../../providers/authRealm';
import { resolveBrowserAuthCredentialSource } from '../../providers/steel/injection';
import { AUTH_TEST_SITE_BASE_PATH } from '../../domains/auth-test-site/config';
import {
  API_KEY,
  assert,
  cleanup,
  createFixture,
  createUser,
  fetchReport,
  getPage,
  pagePath,
  postForm,
  postJson,
  savedPasswordsInListedOrder,
  sessionCookie,
  signPasskeyAssertion,
  test,
  withLocalSite,
  type Manifest,
} from './auth-test-site.testkit';

async function seed(base: string, userId: string, scenario: string): Promise<Manifest> {
  const created = await createFixture(base, { userId, scenario, publicBaseUrl: base });
  assert(created.status === 201, `${scenario} fixture expected 201, got ${created.status}`);
  return (await created.json()) as Manifest;
}

function trail(report: {
  attempts: Array<{ kind: string; outcome: string; reason: string | null }>;
}) {
  return report.attempts.map(
    (a) => `${a.kind}:${a.outcome}${a.reason === null ? '' : `:${a.reason}`}`
  );
}

async function savedSessionCookie(userId: string, manifest: Manifest): Promise<string> {
  const row = await prisma.cookie.findFirst({
    where: { userId, browserProfile: manifest.siteId },
  });
  assert(row !== null, 'fixture must store a session cookie for the user');
  assert(row.domain === '127.0.0.1', `cookie must be on the public host, got ${row.domain}`);
  assert(
    row.path === `${AUTH_TEST_SITE_BASE_PATH}/${manifest.siteId}`,
    `cookie path must be the site's own, got ${row.path}`
  );
  return `${row.name}=${row.value}`;
}

test('saved_session: the saved browser session opens the account with no sign-in', async () => {
  const userId = await createUser('Avery Ross');
  try {
    await withLocalSite(async ({ base }) => {
      const manifest = await seed(base, userId, 'saved_session');
      assert(manifest.savedSession === 'valid', 'manifest must report a valid saved session');
      assert(
        manifest.authOptionsPreview.cookieBundleCount === 1,
        'auth options must list the bundle'
      );
      const cookie = await savedSessionCookie(userId, manifest);
      // The browser session injects whatever this resolves, keyed by the page's real
      // host: the realm is only a label the URL carries on dev hosts.
      assert(
        cookieDomainForStartUrl(manifest.entryUrl) === '127.0.0.1',
        `cookies of an overridden realm live on the page host, got ${cookieDomainForStartUrl(manifest.entryUrl)}`
      );
      const source = await resolveBrowserAuthCredentialSource({
        userId,
        authRealm: manifest.realm,
        steelContextId: null,
        cookieDomain: cookieDomainForStartUrl(manifest.entryUrl),
      });
      assert(
        source.kind === 'cookie_bundle' && source.browserProfile === manifest.siteId,
        `the saved session must be the injected credential source, got ${source.kind}`
      );
      const byRealmLabel = await resolveBrowserAuthCredentialSource({
        userId,
        authRealm: manifest.realm,
        steelContextId: null,
      });
      assert(
        byRealmLabel.kind === 'none',
        'no cookie is stored under the realm label itself; selecting by it is what left the session uninjected'
      );
      const home = await getPage(base, pagePath(manifest, '/'), cookie);
      assert(home.status === 303, `a live session must skip the welcome page, got ${home.status}`);
      const account = await getPage(base, pagePath(manifest, '/account'), cookie);
      assert(
        (await account.text()).includes(manifest.expectedMemberNumber ?? '?'),
        'member number'
      );
      const report = await fetchReport(base, manifest.siteId);
      assert(
        JSON.stringify(trail(report)) === JSON.stringify(['session:resumed']),
        `the session is logged once and nothing else: ${trail(report)}`
      );
      assert(report.sessions[0]?.method === 'saved_session', 'session method');
      assert(report.savedSessionBundle?.disabledAt === null, 'bundle state is reported');

      const removed = await fetch(
        `${base}${AUTH_TEST_SITE_BASE_PATH}/fixtures/${manifest.siteId}`,
        { method: 'DELETE', headers: { 'X-API-Key': API_KEY } }
      );
      assert(removed.status === 200, 'delete');
      assert((await prisma.cookie.count({ where: { userId } })) === 0, 'cookie rows are removed');
      assert((await prisma.cookieBundle.count({ where: { userId } })) === 0, 'bundle is removed');
    });
  } finally {
    await cleanup(userId);
  }
});

test('stale_session: the expired session is refused once, then the saved password signs in', async () => {
  const userId = await createUser('Avery Ross');
  try {
    await withLocalSite(async ({ base }) => {
      const manifest = await seed(base, userId, 'stale_session');
      assert(manifest.savedSession === 'expired', 'manifest must report an expired saved session');
      const cookie = await savedSessionCookie(userId, manifest);
      const home = await getPage(base, pagePath(manifest, '/'), cookie);
      assert(home.status === 200, `expired session must land on sign-in, got ${home.status}`);
      assert((await home.text()).includes('session has expired'), 'page must say it expired');
      await getPage(base, pagePath(manifest, '/account'), cookie);
      const [saved] = await savedPasswordsInListedOrder(userId, manifest);
      assert(saved, 'one saved login expected');
      const signedIn = await postForm(base, pagePath(manifest, '/login'), {
        email: saved.username,
        password: saved.password,
      });
      assert(signedIn.status === 303, 'saved password must work');
      const report = await fetchReport(base, manifest.siteId);
      assert(
        JSON.stringify(trail(report)) ===
          JSON.stringify(['session:rejected:expired_session', 'password:signed_in']),
        `unexpected trail ${trail(report)}`
      );
    });
  } finally {
    await cleanup(userId);
  }
});

async function passkeyAttempt(base: string, userId: string, manifest: Manifest) {
  const options = (await (
    await postJson(base, pagePath(manifest, '/login/passkey/options'), {})
  ).json()) as { challenge: string; rpId: string; allowCredentials: Array<{ id: string }> };
  assert(options.rpId === '127.0.0.1', `rpId must be the public host, got ${options.rpId}`);
  const assertion = await signPasskeyAssertion({
    userId,
    realm: manifest.realm,
    origin: base,
    challenge: options.challenge,
  });
  assert(options.allowCredentials[0]?.id === assertion.credentialId, 'credential id mismatch');
  return { options, assertion };
}

test('passkey: an email-first site signs in with the passkey and never needs the password', async () => {
  const userId = await createUser('Avery Ross');
  try {
    await withLocalSite(async ({ base }) => {
      const manifest = await seed(base, userId, 'passkey');
      assert(manifest.authOptionsPreview.passkeyCount === 1, 'auth options must list the passkey');
      assert(manifest.authOptionsPreview.passwordUsernames.length === 1, 'password is saved too');
      const login = await (await getPage(base, pagePath(manifest, '/login'))).text();
      assert(!login.includes('type="password"'), 'email-first page must not ask for a password');
      const identified = await postForm(base, pagePath(manifest, '/login/identify'), {
        email: manifest.expectedSignInEmail ?? '',
      });
      const methods = await (await getPage(base, identified.headers.get('location') ?? '')).text();
      assert(methods.includes('Sign in with a passkey'), 'passkey button expected');
      assert(methods.includes('type="password"'), 'password stays available as a fallback');

      const { assertion } = await passkeyAttempt(base, userId, manifest);
      const forged = await postJson(base, pagePath(manifest, '/login/passkey'), {
        ...assertion,
        signature: assertion.signature.slice(0, -4) + 'AAAA',
      });
      assert('error' in ((await forged.json()) as object), 'a forged signature must be refused');

      const fresh = await passkeyAttempt(base, userId, manifest);
      const verified = await postJson(base, pagePath(manifest, '/login/passkey'), fresh.assertion);
      const result = (await verified.json()) as { redirect?: string };
      assert(
        result.redirect?.includes('/account') === true,
        `expected redirect, got ${JSON.stringify(result)}`
      );
      const account = await getPage(base, pagePath(manifest, '/account'), sessionCookie(verified));
      assert(
        (await account.text()).includes(manifest.expectedMemberNumber ?? '?'),
        'member number'
      );

      const replay = await postJson(base, pagePath(manifest, '/login/passkey'), fresh.assertion);
      assert('error' in ((await replay.json()) as object), 'a challenge is single-use');

      const report = await fetchReport(base, manifest.siteId);
      assert(
        report.sessions.length === 1 && report.sessions[0]?.method === 'passkey',
        `one passkey session expected: ${JSON.stringify(report.sessions)}`
      );
      assert(!report.attempts.some((a) => a.kind === 'password'), 'no password attempt');
      assert(report.passkey !== null, 'passkey row state is reported');
    });
  } finally {
    await cleanup(userId);
  }
});

test('passkey_rejected: a genuine passkey is refused and the saved password still works', async () => {
  const userId = await createUser('Avery Ross');
  try {
    await withLocalSite(async ({ base }) => {
      const manifest = await seed(base, userId, 'passkey_rejected');
      const { assertion } = await passkeyAttempt(base, userId, manifest);
      const refused = await postJson(base, pagePath(manifest, '/login/passkey'), assertion);
      const body = (await refused.json()) as { error?: string };
      assert(
        body.error?.includes('removed from your account') === true,
        `got ${JSON.stringify(body)}`
      );
      const [saved] = await savedPasswordsInListedOrder(userId, manifest);
      assert(saved, 'one saved login expected');
      const signedIn = await postForm(base, pagePath(manifest, '/login'), {
        email: saved.username,
        password: saved.password,
      });
      assert(signedIn.status === 303, 'the saved password must work');
      const report = await fetchReport(base, manifest.siteId);
      assert(
        JSON.stringify(trail(report)) ===
          JSON.stringify(['passkey:rejected:passkey_not_recognized', 'password:signed_in']),
        `unexpected trail ${trail(report)}`
      );
    });
  } finally {
    await cleanup(userId);
  }
});

/**
 * Runs the methods page's own passkey script against the in-process site, the
 * way a browser would. `network` may answer a request itself (a proxy error
 * page) instead of letting it reach the site; `authenticator` plays the
 * browser's navigator.credentials.get.
 */
async function clickPasskeyButton(
  base: string,
  html: string,
  network: (url: string) => Response | null,
  authenticator: (challenge: string) => Promise<Record<string, Uint8Array>>
): Promise<{ status: string; redirect: string | null }> {
  const script = /<script>([\s\S]*?passkey-button[\s\S]*?)<\/script>/.exec(html)?.[1];
  assert(script, 'the methods page must carry the passkey script');
  let settle: (outcome: { status: string; redirect: string | null }) => void = () => {};
  const settled = new Promise<{ status: string; redirect: string | null }>((resolve) => {
    settle = resolve;
  });
  // The script sets className before textContent; an error's text is its final write.
  const status = {
    className: '',
    set textContent(text: string) {
      if (this.className === 'error') settle({ status: text, redirect: null });
    },
  };
  let click: (() => void) | null = null;
  const sandbox = {
    atob: (text: string) => Buffer.from(text, 'base64').toString('latin1'),
    btoa: (text: string) => Buffer.from(text, 'latin1').toString('base64'),
    Uint8Array,
    JSON,
    document: {
      getElementById: (id: string) =>
        id === 'passkey-status'
          ? status
          : { addEventListener: (_event: string, handler: () => void) => (click = handler) },
    },
    window: { location: { assign: (url: string) => settle({ status: '', redirect: url }) } },
    navigator: {
      credentials: {
        get: (request: { publicKey: { challenge: Uint8Array } }) =>
          authenticator(Buffer.from(request.publicKey.challenge).toString('base64url')),
      },
    },
    fetch: (url: string, init: RequestInit) =>
      Promise.resolve(network(url) ?? fetch(new URL(url, base), init)),
  };
  runInNewContext(script, sandbox);
  assert(click, 'the passkey button must have a click handler');
  (click as () => void)();
  const timeout = new Promise<never>((_resolve, reject) =>
    setTimeout(() => reject(new Error('the passkey click never settled')), 10_000).unref()
  );
  return Promise.race([settled, timeout]);
}

function signedCredential(userId: string, manifest: Manifest, base: string) {
  return async (challenge: string) => {
    const assertion = await signPasskeyAssertion({
      userId,
      realm: manifest.realm,
      origin: base,
      challenge,
    });
    const bytes = (value: string) => new Uint8Array(Buffer.from(value, 'base64url'));
    return {
      rawId: bytes(assertion.credentialId),
      response: {
        clientDataJSON: bytes(assertion.clientDataJSON),
        authenticatorData: bytes(assertion.authenticatorData),
        signature: bytes(assertion.signature),
      },
    } as unknown as Record<string, Uint8Array>;
  };
}

const PROXY_ERROR_PAGE = () =>
  new Response('<!doctype html><title>502 Bad Gateway</title>', {
    status: 502,
    headers: { 'Content-Type': 'text/html' },
  });

test('passkey_rejected: a lost passkey request is not reported as a missing passkey', async () => {
  // r002-j0052: a proxy answered POST /login/passkey/options with a 502 page.
  // The script's catch-all then told the site "no passkey in this browser",
  // so the attempt the agent never got to make was recorded as passkey_unavailable.
  const userId = await createUser('Avery Ross');
  try {
    await withLocalSite(async ({ base }) => {
      const manifest = await seed(base, userId, 'passkey_rejected');
      const identified = await postForm(base, pagePath(manifest, '/login/identify'), {
        email: manifest.expectedSignInEmail ?? '',
      });
      const methods = await (await getPage(base, identified.headers.get('location') ?? '')).text();
      const authenticator = signedCredential(userId, manifest, base);

      for (const lost of ['/login/passkey/options', '/login/passkey?']) {
        const failed = await clickPasskeyButton(
          base,
          methods,
          (url) => (url.includes(lost) ? PROXY_ERROR_PAGE() : null),
          authenticator
        );
        assert(
          failed.redirect === null && /try again/i.test(failed.status),
          `a lost ${lost} request must ask the shopper to retry, got ${JSON.stringify(failed)}`
        );
        assert(
          !/could not use a passkey in this browser/i.test(failed.status),
          `a lost ${lost} request must not claim the browser has no passkey`
        );
        assert(
          trail(await fetchReport(base, manifest.siteId)).length === 0,
          `a lost ${lost} request must record no passkey attempt`
        );
      }

      const retried = await clickPasskeyButton(base, methods, () => null, authenticator);
      assert(
        retried.status.includes('removed from your account'),
        `the retry must reach the site's verdict, got ${JSON.stringify(retried)}`
      );
      const noAuthenticator = await clickPasskeyButton(
        base,
        methods,
        () => null,
        () => Promise.reject(new Error('NotAllowedError'))
      );
      assert(
        noAuthenticator.status.includes('could not use a passkey in this browser'),
        `a browser without the passkey is still reported, got ${JSON.stringify(noAuthenticator)}`
      );
      assert(
        JSON.stringify(trail(await fetchReport(base, manifest.siteId))) ===
          JSON.stringify([
            'passkey:rejected:passkey_not_recognized',
            'passkey:rejected:passkey_unavailable',
          ]),
        `unexpected trail ${trail(await fetchReport(base, manifest.siteId))}`
      );
    });
  } finally {
    await cleanup(userId);
  }
});

test('all_fail: every rung the user has is offered and fails, and minted stays hidden', async () => {
  const userId = await createUser('Avery Ross');
  try {
    await withLocalSite(async ({ base, sentMail }) => {
      const manifest = await seed(base, userId, 'all_fail');
      const preview = manifest.authOptionsPreview;
      assert(
        preview.cookieBundleCount === 1 &&
          preview.passkeyCount === 1 &&
          preview.passwordUsernames.length === 3 &&
          preview.mintedEmail === null,
        `the ladder must show session, passkey and three passwords, no minted: ${JSON.stringify(preview)}`
      );
      assert(
        manifest.userSignIn === null && manifest.expectedSignInEmail === null,
        'nothing works'
      );
      const cookie = await savedSessionCookie(userId, manifest);
      const home = await getPage(base, pagePath(manifest, '/'), cookie);
      assert((await home.text()).includes('session has expired'), 'expired session notice');
      const { assertion } = await passkeyAttempt(base, userId, manifest);
      await postJson(base, pagePath(manifest, '/login/passkey'), assertion);
      for (const credential of await savedPasswordsInListedOrder(userId, manifest)) {
        const response = await postForm(base, pagePath(manifest, '/login'), {
          email: credential.username,
          password: credential.password,
        });
        assert(response.status === 200, `saved password for ${credential.username} must fail`);
        assert(
          (await response.text()).includes('Sign in with a passkey'),
          'email-first methods page'
        );
      }
      await postForm(base, pagePath(manifest, '/login/code'), {
        email: manifest.savedPasswordUsernames[0] ?? '',
      });
      await postForm(base, pagePath(manifest, '/login/sms'), { phone: '+1 (555) 555-0199' });
      const signUp = await postForm(base, pagePath(manifest, '/signup'), {
        name: 'Avery Ross',
        email: manifest.savedPasswordUsernames[1] ?? '',
        password: 'a-new-password-1',
      });
      assert(
        (await signUp.text()).includes('is not accepting new accounts'),
        'sign-up must be unavailable'
      );
      const guest = await getPage(base, pagePath(manifest, '/guest'));
      assert((await guest.text()).includes('only shown to signed-in members'), 'guest page');
      assert(sentMail.length === 0, 'no mail may leave for addresses we cannot receive');

      const report = await fetchReport(base, manifest.siteId);
      assert(report.sessions.length === 0, 'no session may exist');
      const kinds = trail(report);
      assert(
        JSON.stringify(kinds) ===
          JSON.stringify([
            'session:rejected:expired_session',
            'passkey:rejected:passkey_not_recognized',
            'password:rejected:wrong_password',
            'password:rejected:unknown_account',
            'password:rejected:wrong_password',
            'code_request:code_withheld',
            'sms_request:code_withheld:unknown_account',
            'signup:rejected:signup_unavailable',
            'guest:started',
          ]),
        `unexpected trail ${kinds}`
      );
    });
  } finally {
    await cleanup(userId);
  }
});

test('account_locked: the saved password and a code request both hit the lock', async () => {
  const userId = await createUser('Avery Ross');
  try {
    await withLocalSite(async ({ base }) => {
      const manifest = await seed(base, userId, 'account_locked');
      const [saved] = await savedPasswordsInListedOrder(userId, manifest);
      assert(saved, 'one saved login expected');
      const refused = await postForm(base, pagePath(manifest, '/login'), {
        email: saved.username,
        password: saved.password,
      });
      assert((await refused.text()).includes('This account is locked'), 'lock message expected');
      await postForm(base, pagePath(manifest, '/login/code'), { email: saved.username });
      const report = await fetchReport(base, manifest.siteId);
      assert(
        JSON.stringify(trail(report)) ===
          JSON.stringify(['password:rejected:locked', 'code_request:code_withheld:locked']),
        `unexpected trail ${trail(report)}`
      );
      assert(report.sessions.length === 0, 'a locked account never signs in');
    });
  } finally {
    await cleanup(userId);
  }
});

test('named_account and failed_login_not_reoffered seed two distinct member accounts', async () => {
  const userId = await createUser('Avery Ross');
  try {
    await withLocalSite(async ({ base }) => {
      const named = await seed(base, userId, 'named_account');
      const [fresh, older] = await savedPasswordsInListedOrder(userId, named);
      assert(fresh && older, 'two saved logins expected');
      assert(named.namedAccountEmail === older.username, 'the prompt names the older login');
      for (const credential of [fresh, older]) {
        const response = await postForm(base, pagePath(named, '/login'), {
          email: credential.username,
          password: credential.password,
        });
        assert(response.status === 303, `${credential.username} must work`);
      }
      const namedReport = await fetchReport(base, named.siteId);
      const numbers = new Set(namedReport.accounts.map((account) => account.memberNumber));
      assert(
        numbers.size === 2 && numbers.has(named.expectedMemberNumber ?? ''),
        'distinct accounts'
      );

      const reoffer = await seed(base, userId, 'failed_login_not_reoffered');
      const [stale, working] = await savedPasswordsInListedOrder(userId, reoffer);
      assert(stale && working, 'two saved logins expected');
      const failed = await postForm(base, pagePath(reoffer, '/login'), {
        email: stale.username,
        password: stale.password,
      });
      assert(failed.status === 200, 'the freshest saved login is stale');
      const marked = await fetch(
        `${base}${AUTH_TEST_SITE_BASE_PATH}/fixtures/${reoffer.siteId}/mark`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
          body: JSON.stringify({ label: 'run-2' }),
        }
      );
      assert(marked.status === 201, `mark expected 201, got ${marked.status}`);
      const ok = await postForm(base, pagePath(reoffer, '/login'), {
        email: working.username,
        password: working.password,
      });
      assert(
        ok.status === 303 && reoffer.expectedSignInEmail === working.username,
        'older login works'
      );
      const report = await fetchReport(base, reoffer.siteId);
      assert(
        JSON.stringify(trail(report)) ===
          JSON.stringify([
            'password:rejected:wrong_password',
            'run_marker:started',
            'password:signed_in',
          ]),
        `unexpected trail ${trail(report)}`
      );
    });
  } finally {
    await cleanup(userId);
  }
});
