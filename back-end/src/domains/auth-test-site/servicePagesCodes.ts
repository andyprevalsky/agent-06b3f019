import { phoneSmsNotice } from './servicePhoneSms';
/** Pages for the code, link and sign-up flows. */

import { normalizeEmail } from './serviceSignIn';
import { AUTH_TEST_SITE_NAME } from './config';
import { siteUrl } from './service';
import { banner, escapeHtml, layout, nextField, nextQuery, type NextPage } from './servicePages';
import { MIN_PASSWORD_LENGTH } from './serviceSignUp';
import type { AuthTestSite } from './types';

export function renderCodeRequestPage(
  site: AuthTestSite,
  options: { email?: string; next?: NextPage } = {}
): string {
  const next = options.next ?? null;
  const link = site.behavior.emailSignIn === 'link';
  const thing = link ? 'sign-in link' : '6-digit sign-in code';
  return layout(
    site,
    link ? 'Sign in with a link' : 'Sign in with a code',
    `    <h1>${link ? 'Sign in with an emailed link' : 'Sign in with an emailed code'}</h1>
    <p>Enter the email address on your membership and we will email you a ${thing}.</p>
    <form method="post" action="${siteUrl(site, '/login/code')}">
      ${nextField(next)}
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="username" required value="${escapeHtml(options.email ?? '')}">
      <button type="submit">${link ? 'Email me a sign-in link' : 'Email me a sign-in code'}</button>
    </form>
    <p><a href="${siteUrl(site, '/login')}${nextQuery(next)}">Back to sign in</a></p>`
  );
}

export type CodePage = 'sign_in' | 'second_factor' | 'signup' | 'sms';

const CODE_PAGES: Record<CodePage, { verify: string; resend: string; label: string }> = {
  sign_in: { verify: '/login/code/verify', resend: '/login/code', label: 'Sign-in code' },
  second_factor: {
    verify: '/login/verify',
    resend: '/login/verify/resend',
    label: 'Verification code',
  },
  signup: { verify: '/signup/verify', resend: '/signup/resend', label: 'Verification code' },
  sms: { verify: '/login/sms/verify', resend: '/login/sms', label: 'Sign-in code' },
};

/**
 * A member who asks for a code is told it was sent; the hedge ("if … belongs
 * to an account") is only for addresses the site does not know. Hedging at a
 * known member made agents doubt the account instead of waiting for the code.
 */
function codeNotice(site: AuthTestSite, page: CodePage, rawTarget: string): string {
  if (page === 'sms' && site.scenario === 'phone_sms_otp') return phoneSmsNotice(site);
  const digits = (value: string | null) => (value ?? '').replace(/\D/g, '');
  // Match on the normalized address the agent typed (case, surrounding space),
  // not the HTML-escaped display string, or a known member reads the hedge.
  const known = site.accounts.some(
    (account) =>
      (normalizeEmail(account.email) === normalizeEmail(rawTarget) ||
        (digits(account.phone) !== '' && digits(account.phone) === digits(rawTarget))) &&
      account.verified &&
      !account.locked
  );
  const target = escapeHtml(rawTarget);
  if (page === 'sms') {
    return known
      ? `We texted a 6-digit sign-in code to ${target}. It expires in 10 minutes.`
      : `If ${target} is on a ${AUTH_TEST_SITE_NAME} account, we texted it a 6-digit sign-in code. It expires in 10 minutes.`;
  }
  if (page === 'second_factor') {
    return `To finish signing in, enter the 6-digit verification code we emailed to ${target}. It expires in 10 minutes.`;
  }
  if (page === 'signup') {
    return `Almost done. Enter the 6-digit verification code we emailed to ${target} to finish creating your account.`;
  }
  return known
    ? `We emailed a 6-digit sign-in code to ${target}. It expires in 10 minutes.`
    : `If ${target} belongs to a ${AUTH_TEST_SITE_NAME} account, a 6-digit sign-in code is on its way. It expires in 10 minutes.`;
}

/** The code entry form shared by emailed sign-in codes, second factors, sign-up and texted codes. */
export function renderCodeEntryPage(
  site: AuthTestSite,
  page: CodePage,
  options: { target: string; error?: string; next?: NextPage }
): string {
  const next = options.next ?? null;
  const target = site.scenario === 'phone_sms_otp' ? '' : escapeHtml(options.target);
  const field = page === 'sms' ? 'phone' : 'email';
  const paths = CODE_PAGES[page];
  return layout(
    site,
    'Enter your code',
    `    <h1>${page === 'sms' ? 'Check your phone' : 'Check your email'}</h1>
    <p class="notice">${codeNotice(site, page, options.target)}</p>
    ${banner('error', options.error)}
    <form method="post" action="${siteUrl(site, paths.verify)}">
      ${nextField(next)}
      <input type="hidden" name="${field}" value="${target}">
      <label for="code">${paths.label}</label>
      <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" required>
      <button type="submit">Verify</button>
    </form>
    <form method="post" action="${siteUrl(site, paths.resend)}">
      ${nextField(next)}
      <input type="hidden" name="${field}" value="${target}">
      <button type="submit">Resend code</button>
    </form>
    <p><a href="${siteUrl(site, '/login')}${nextQuery(next)}">Back to sign in</a></p>`
  );
}

export function renderLinkSentPage(
  site: AuthTestSite,
  options: { email: string; next?: NextPage }
) {
  const next = options.next ?? null;
  const email = escapeHtml(options.email);
  return layout(
    site,
    'Check your email',
    `    <h1>Check your email</h1>
    <p class="notice">If ${email} belongs to a ${AUTH_TEST_SITE_NAME} account, we emailed it a sign-in link. Open the link to sign in. It expires in 10 minutes.</p>
    <form method="post" action="${siteUrl(site, '/login/code')}">
      ${nextField(next)}
      <input type="hidden" name="email" value="${email}">
      <button type="submit">Resend link</button>
    </form>
    <p><a href="${siteUrl(site, '/login')}${nextQuery(next)}">Back to sign in</a></p>`
  );
}

export function renderSmsRequestPage(
  site: AuthTestSite,
  options: { phone?: string; next?: NextPage } = {}
): string {
  const next = options.next ?? null;
  return layout(
    site,
    'Sign in with a text',
    `    <h1>Sign in with a texted code</h1>
    <p>Enter the phone number on your membership and we will text you a 6-digit sign-in code.</p>
    <form method="post" action="${siteUrl(site, '/login/sms')}">
      ${nextField(next)}
      <label for="phone">Phone number</label>
${site.scenario === 'phone_sms_otp' ? '<p>Use the registered phone on your membership.</p>' : `      <input id="phone" name="phone" type="tel" autocomplete="tel" required value="${escapeHtml(options.phone ?? '')}">`}
      <button type="submit">Text me a sign-in code</button>
    </form>
    <p><a href="${siteUrl(site, '/login')}${nextQuery(next)}">Back to sign in</a></p>`
  );
}

export function renderSignUpPage(
  site: AuthTestSite,
  options: { name?: string; email?: string; error?: string; next?: NextPage } = {}
): string {
  const next = options.next ?? null;
  return layout(
    site,
    'Create an account',
    `    <h1>Create your ${AUTH_TEST_SITE_NAME} account</h1>
    ${banner('error', options.error)}
    <form method="post" action="${siteUrl(site, '/signup')}">
      ${nextField(next)}
      <label for="name">Full name</label>
      <input id="name" name="name" autocomplete="name" required value="${escapeHtml(options.name ?? '')}">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="email" required value="${escapeHtml(options.email ?? '')}">
      <label for="new-password">Password (at least ${MIN_PASSWORD_LENGTH} characters)</label>
      <input id="new-password" name="password" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD_LENGTH}" required>
      <button type="submit">Create account</button>
    </form>
    <p>Already a member? <a href="${siteUrl(site, '/login')}${nextQuery(next)}">Sign in</a></p>`
  );
}
