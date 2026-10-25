/**
 * Server-rendered sign-in pages. Plain forms and no CAPTCHA — the only thing
 * under test is whether the agent works through the sign-in options it has.
 * Every link and form action carries ?authRealm= so the browser agent keeps
 * this site's per-run credential realm on every page. The one script on the
 * site is the passkey button, which has to call WebAuthn.
 */

import { AUTH_TEST_SITE_NAME } from './config';
import { siteUrl } from './service';
import type { AuthTestSite, SiteSession } from './types';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Where a successful sign-in should land; only the checkout is a valid detour. */
export type NextPage = 'checkout' | null;

export function nextQuery(next: NextPage): string {
  return next === null ? '' : `&next=${next}`;
}

export function nextField(next: NextPage): string {
  return next === null ? '' : `<input type="hidden" name="next" value="${next}">`;
}

export function banner(kind: 'error' | 'notice', message: string | undefined): string {
  if (message === undefined) return '';
  const role = kind === 'error' ? ' role="alert"' : '';
  return `<p class="${kind}"${role}>${escapeHtml(message)}</p>`;
}

export function layout(site: AuthTestSite | null, title: string, body: string): string {
  const home = site === null ? '' : `<a class="brand" href="${siteUrl(site)}">`;
  const homeEnd = site === null ? '' : '</a>';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · ${AUTH_TEST_SITE_NAME}</title>
  <style>
    body { font-family: Georgia, serif; margin: 0; color: #1f2a24; background: #f6f4ef; }
    header { background: #2f4a3a; color: #fff; padding: 14px 32px; }
    header .brand { color: #fff; text-decoration: none; font-size: 20px; font-weight: 700; }
    main { max-width: 560px; margin: 40px auto; background: #fff; padding: 28px 32px;
      border: 1px solid #d8d3c8; border-radius: 6px; }
    label { display: block; font-weight: 700; margin: 14px 0 6px; }
    input { width: 100%; box-sizing: border-box; font: inherit; padding: 10px; border: 1px solid #9a9486; border-radius: 4px; }
    button { margin-top: 18px; font: inherit; padding: 10px 16px; border: 0; border-radius: 4px;
      background: #2f4a3a; color: #fff; cursor: pointer; }
    .error { background: #fbe9e7; color: #8a1c0b; padding: 10px 12px; border-radius: 4px; }
    .notice { background: #eef4ea; padding: 10px 12px; border-radius: 4px; }
    dt { font-weight: 700; margin-top: 10px; }
    dd { margin: 4px 0 0; }
    table { width: 100%; border-collapse: collapse; }
    td, th { text-align: left; padding: 6px 4px; border-bottom: 1px solid #e6e1d6; }
    .product { border: 1px solid #d8d3c8; border-radius: 6px; padding: 12px; margin: 12px 0; }
    .product img { max-width: 160px; display: block; }
  </style>
</head>
<body>
  <header>${home}${AUTH_TEST_SITE_NAME}${homeEnd}</header>
  <main>
${body}
  </main>
</body>
</html>`;
}

/** Links to every other way in that the site offers, for the foot of a sign-in page. */
function otherWays(site: AuthTestSite, current: string, email: string, next: NextPage): string {
  const emailQuery = email === '' ? '' : `&email=${encodeURIComponent(email)}`;
  const links: Array<[string, string, string]> = [];
  if (site.behavior.passwordSignIn && current !== 'password') {
    links.push(['password', '/login', 'Use a password instead']);
  }
  if (site.behavior.emailSignIn === 'link') {
    links.push(['code', '/login/code', 'Email me a sign-in link instead']);
  } else if (site.behavior.emailSignIn !== 'off') {
    links.push(['code', '/login/code', 'Email me a sign-in code instead']);
  }
  if (site.behavior.smsSignIn !== 'off') {
    links.push(['sms', '/login/sms', 'Text me a sign-in code instead']);
  }
  if (site.behavior.signUp !== 'off') {
    links.push(['signup', '/signup', 'Create an account']);
  }
  if (site.behavior.guest !== 'off') {
    links.push(['guest', '/guest', 'Continue as guest']);
  }
  return links
    .filter(([key]) => key !== current)
    .map(
      ([key, path, label]) =>
        `<p><a href="${siteUrl(site, path)}${key === 'code' ? emailQuery : ''}${nextQuery(next)}">${label}</a></p>`
    )
    .join('\n    ');
}

export function renderWelcomePage(site: AuthTestSite): string {
  const signUp =
    site.behavior.signUp === 'off'
      ? ''
      : `<p><a href="${siteUrl(site, '/signup')}">Create an account</a></p>`;
  const guest =
    site.behavior.guest === 'off'
      ? ''
      : `<p><a href="${siteUrl(site, '/guest')}">Continue as guest</a></p>`;
  return layout(
    site,
    'Welcome',
    `    <h1>Welcome to ${AUTH_TEST_SITE_NAME}</h1>
    <p>Sign in to see your membership details, member number, and plan.</p>
    <p><a href="${siteUrl(site, '/login')}">Sign in</a></p>
    ${signUp}
    ${guest}`
  );
}

export interface LoginPageOptions {
  email?: string;
  error?: string;
  notice?: string;
  next?: NextPage;
}

function passkeyBlock(site: AuthTestSite, next: NextPage): string {
  if (site.behavior.passkey === 'off' || site.passkey === null) return '';
  const optionsUrl = JSON.stringify(siteUrl(site, '/login/passkey/options'));
  const verifyUrl = JSON.stringify(`${siteUrl(site, '/login/passkey')}${nextQuery(next)}`);
  return `<button type="button" id="passkey-button">Sign in with a passkey</button>
    <p id="passkey-status" role="status"></p>
    <script>
    (function () {
      var toBytes = function (text) {
        var padded = text.replace(/-/g, '+').replace(/_/g, '/');
        while (padded.length % 4) padded += '=';
        var binary = atob(padded);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
      };
      var toText = function (buffer) {
        var bytes = new Uint8Array(buffer);
        var binary = '';
        for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
      };
      var post = function (url, payload) {
        return fetch(url, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).then(function (response) { return response.json(); });
      };
      var status = document.getElementById('passkey-status');
      document.getElementById('passkey-button').addEventListener('click', function () {
        status.className = 'notice';
        status.textContent = 'Checking your passkey…';
        post(${optionsUrl}, {})
          .then(function (options) {
            return navigator.credentials.get({
              publicKey: {
                challenge: toBytes(options.challenge),
                rpId: options.rpId,
                userVerification: 'preferred',
                allowCredentials: options.allowCredentials.map(function (entry) {
                  return { type: entry.type, id: toBytes(entry.id) };
                }),
              },
            });
          })
          .then(function (credential) {
            return post(${verifyUrl}, {
              credentialId: toText(credential.rawId),
              clientDataJSON: toText(credential.response.clientDataJSON),
              authenticatorData: toText(credential.response.authenticatorData),
              signature: toText(credential.response.signature),
            });
          })
          .catch(function () { return post(${verifyUrl}, { unavailable: true }); })
          .then(function (result) {
            if (result.redirect) { window.location.assign(result.redirect); return; }
            status.className = 'error';
            status.textContent = result.error;
          });
      });
    })();
    </script>`;
}

function passwordForm(site: AuthTestSite, email: string, next: NextPage, fixedEmail: boolean) {
  if (!site.behavior.passwordSignIn) return '';
  const emailInput = fixedEmail
    ? `<input type="hidden" name="email" value="${escapeHtml(email)}">`
    : `<label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="username" required value="${escapeHtml(email)}">`;
  return `<form method="post" action="${siteUrl(site, '/login')}">
      ${nextField(next)}
      ${emailInput}
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button type="submit">Sign in</button>
    </form>`;
}

/** The sign-in page: one form, or just the email step on a site that asks for it first. */
export function renderLoginPage(site: AuthTestSite, options: LoginPageOptions = {}): string {
  const next = options.next ?? null;
  const email = options.email ?? '';
  const form = site.behavior.identifierFirst
    ? `<form method="post" action="${siteUrl(site, '/login/identify')}">
      ${nextField(next)}
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="username webauthn" required value="${escapeHtml(email)}">
      <button type="submit">Continue</button>
    </form>`
    : passwordForm(site, email, next, false);
  return layout(
    site,
    'Sign in',
    `    <h1>Sign in</h1>
    ${banner('notice', options.notice)}
    ${banner('error', options.error)}
    ${form}
    ${otherWays(site, 'password', email, next)}`
  );
}

/** Step two on a site that asks for the email first: every method for that account. */
export function renderMethodsPage(
  site: AuthTestSite,
  options: { email: string; error?: string; next?: NextPage }
): string {
  const next = options.next ?? null;
  return layout(
    site,
    'Sign in',
    `    <h1>Sign in</h1>
    <p>Signing in as <strong>${escapeHtml(options.email)}</strong>. <a href="${siteUrl(site, '/login')}${nextQuery(next)}">Use a different email</a></p>
    ${banner('error', options.error)}
    ${passkeyBlock(site, next)}
    ${passwordForm(site, options.email, next, true)}
    ${otherWays(site, 'password', options.email, next)}`
  );
}

export function renderAccountPage(
  site: AuthTestSite,
  session: SiteSession,
  memberNumber: string | null,
  memberName: string | null,
  orderHistory = ''
): string {
  const shop = site.behavior.shop ? `<p><a href="${siteUrl(site)}">Back to the shop</a></p>` : '';
  return layout(
    site,
    'Your membership',
    `    <h1>Your membership</h1>
    <p>Signed in as <strong>${escapeHtml(session.email)}</strong></p>
    <dl>${
      memberName === null
        ? ''
        : `
      <dt>Member name</dt>
      <dd id="member-name">${escapeHtml(memberName)}</dd>`
    }
      <dt>Member number</dt>
      <dd id="member-number">${escapeHtml(memberNumber ?? 'Unavailable')}</dd>
      <dt>Plan</dt>
      <dd>Rose Shop Annual</dd>
      <dt>Status</dt>
      <dd>Active</dd>
    </dl>
    ${orderHistory}
    ${shop}
    <form method="post" action="${siteUrl(site, '/logout')}">
      <button type="submit">Sign out</button>
    </form>`
  );
}

export function renderGuestPage(site: AuthTestSite): string {
  return layout(
    site,
    'Browsing as a guest',
    `    <h1>You're browsing as a guest</h1>
    <p>Guests can look around ${AUTH_TEST_SITE_NAME}. Membership details, member numbers and plans are only shown to signed-in members.</p>
    <p><a href="${siteUrl(site, '/login')}">Sign in</a></p>`
  );
}

export function renderNotFoundPage(): string {
  return layout(
    null,
    'Not found',
    `    <h1>Page not found</h1>
    <p>This ${AUTH_TEST_SITE_NAME} page does not exist or has expired.</p>`
  );
}
