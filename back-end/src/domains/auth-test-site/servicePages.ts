/**
 * Server-rendered pages. Plain forms, no scripts, no CAPTCHA — the only thing
 * under test is whether the agent works through the sign-in options it has.
 * Every link and form action carries ?authRealm= so the browser agent keeps
 * this site's per-run credential realm on every page.
 */

import { AUTH_TEST_SITE_NAME } from './config';
import { siteUrl } from './service';
import type { AuthTestSite, SiteSession } from './types';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function layout(site: AuthTestSite | null, title: string, body: string): string {
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
    main { max-width: 460px; margin: 40px auto; background: #fff; padding: 28px 32px;
      border: 1px solid #d8d3c8; border-radius: 6px; }
    label { display: block; font-weight: 700; margin: 14px 0 6px; }
    input { width: 100%; box-sizing: border-box; font: inherit; padding: 10px; border: 1px solid #9a9486; border-radius: 4px; }
    button { margin-top: 18px; font: inherit; padding: 10px 16px; border: 0; border-radius: 4px;
      background: #2f4a3a; color: #fff; cursor: pointer; }
    .error { background: #fbe9e7; color: #8a1c0b; padding: 10px 12px; border-radius: 4px; }
    .notice { background: #eef4ea; padding: 10px 12px; border-radius: 4px; }
    dt { font-weight: 700; margin-top: 10px; }
    dd { margin: 4px 0 0; }
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

export function renderHomePage(site: AuthTestSite): string {
  return layout(
    site,
    'Welcome',
    `    <h1>Welcome to ${AUTH_TEST_SITE_NAME}</h1>
    <p>Sign in to see your membership details, member number, and plan.</p>
    <p><a href="${siteUrl(site, '/login')}">Sign in</a></p>`
  );
}

export function renderLoginPage(
  site: AuthTestSite,
  options: { email?: string; error?: string } = {}
): string {
  const error =
    options.error === undefined
      ? ''
      : `<p class="error" role="alert">${escapeHtml(options.error)}</p>`;
  return layout(
    site,
    'Sign in',
    `    <h1>Sign in</h1>
    ${error}
    <form method="post" action="${siteUrl(site, '/login')}">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="username" required value="${escapeHtml(options.email ?? '')}">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button type="submit">Sign in</button>
    </form>
    <p><a href="${siteUrl(site, '/login/code')}">Email me a sign-in code instead</a></p>`
  );
}

export function renderCodeRequestPage(
  site: AuthTestSite,
  options: { email?: string } = {}
): string {
  return layout(
    site,
    'Sign in with a code',
    `    <h1>Sign in with an emailed code</h1>
    <p>Enter the email address on your membership and we will email you a 6-digit sign-in code.</p>
    <form method="post" action="${siteUrl(site, '/login/code')}">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="username" required value="${escapeHtml(options.email ?? '')}">
      <button type="submit">Email me a sign-in code</button>
    </form>
    <p><a href="${siteUrl(site, '/login')}">Use a password instead</a></p>`
  );
}

export function renderCodeEntryPage(
  site: AuthTestSite,
  options: { email: string; error?: string }
): string {
  const email = escapeHtml(options.email);
  const error =
    options.error === undefined
      ? ''
      : `<p class="error" role="alert">${escapeHtml(options.error)}</p>`;
  return layout(
    site,
    'Enter your code',
    `    <h1>Check your email</h1>
    <p class="notice">If ${email} belongs to a ${AUTH_TEST_SITE_NAME} account, a 6-digit sign-in code is on its way. It expires in 10 minutes.</p>
    ${error}
    <form method="post" action="${siteUrl(site, '/login/code/verify')}">
      <input type="hidden" name="email" value="${email}">
      <label for="code">Sign-in code</label>
      <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" required>
      <button type="submit">Verify and sign in</button>
    </form>
    <form method="post" action="${siteUrl(site, '/login/code')}">
      <input type="hidden" name="email" value="${email}">
      <button type="submit">Resend sign-in code</button>
    </form>
    <p><a href="${siteUrl(site, '/login')}">Use a password instead</a></p>`
  );
}

export function renderAccountPage(
  site: AuthTestSite,
  session: SiteSession,
  memberNumber: string | null
): string {
  return layout(
    site,
    'Your membership',
    `    <h1>Your membership</h1>
    <p>Signed in as <strong>${escapeHtml(session.email)}</strong></p>
    <dl>${
      site.holderName === null
        ? ''
        : `
      <dt>Member name</dt>
      <dd id="member-name">${escapeHtml(site.holderName)}</dd>`
    }
      <dt>Member number</dt>
      <dd id="member-number">${escapeHtml(memberNumber ?? 'Unavailable')}</dd>
      <dt>Plan</dt>
      <dd>Rose Shop Annual</dd>
      <dt>Status</dt>
      <dd>Active</dd>
    </dl>
    <form method="post" action="${siteUrl(site, '/logout')}">
      <button type="submit">Sign out</button>
    </form>`
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
