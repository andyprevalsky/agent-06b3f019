/**
 * Password acceptance binds a pending challenge to the login browser's cookie.
 * A separate app/device, holding its own capability, acknowledges the number.
 * Only the original login browser can consume that approval and start a session.
 *
 * password -> pending browser cookie -> app approval -> same browser session
 *                         expired / wrong number -> no session
 */

import { Router, type Request, type Response } from 'express';
import { siteUrl } from './service';
import { escapeHtml, layout, nextQuery } from './servicePages';
import { recordAttempt, secretsEqual, startSession } from './serviceSignIn';
import {
  appApprovalToken,
  completeSignIn,
  formField,
  nextOf,
  queryField,
  sendPage,
  sessionOf,
  setAppApprovalCookie,
  siteOf,
} from './routesShared';
import type { AppApprovalChallenge, AuthTestSite } from './types';

export const appApprovalRouter = Router();

function pendingChallenge(site: AuthTestSite, token: string | null): AppApprovalChallenge | null {
  return (
    site.appApprovals.find((challenge) => !challenge.consumed && challenge.token === token) ?? null
  );
}

function deviceChallenge(site: AuthTestSite): AppApprovalChallenge | null {
  return (
    [...site.appApprovals]
      .reverse()
      .find((challenge) => !challenge.consumed && challenge.email === site.signInEmail) ?? null
  );
}

function devicePage(res: Response, site: AuthTestSite, html: string, status = 200): void {
  // The app is a different device; its page must not overwrite the login browser's last page.
  res
    .status(status)
    .type('html')
    .setHeader('Cache-Control', 'no-store')
    .send(layout(site, 'Rose Authenticator', html));
}

function deviceAuthorized(req: Request, site: AuthTestSite): boolean {
  const key = queryField(req, 'key');
  return (
    site.appApprovalDeviceKey !== null && key !== '' && secretsEqual(key, site.appApprovalDeviceKey)
  );
}

function renderDevice(
  res: Response,
  site: AuthTestSite,
  challenge: AppApprovalChallenge,
  error?: string
): void {
  if (challenge.approvedAt !== null) {
    devicePage(
      res,
      site,
      '<h1>Sign-in approved</h1><p data-app-approval-status="approved">You can return to your browser.</p>'
    );
    return;
  }
  devicePage(
    res,
    site,
    `<h1>Approve a sign-in</h1>
    <p>A browser is signing in as ${escapeHtml(challenge.email)}. Enter the number shown in that browser.</p>
    ${error === undefined ? '' : `<p role="alert">${escapeHtml(error)}</p>`}
    <form method="post" action="${siteUrl(site, '/device/approve')}&key=${site.appApprovalDeviceKey}">
      <input type="hidden" name="challenge" value="${escapeHtml(challenge.token)}">
      <label for="number">Sign-in number</label>
      <input id="number" name="number" inputmode="numeric" pattern="[0-9]{2}" required autocomplete="off">
      <button type="submit">Approve sign-in</button>
    </form>`,
    error === undefined ? 200 : 400
  );
}

appApprovalRouter.get('/:siteId/login/approve', (req: Request, res: Response) => {
  const site = siteOf(req);
  const next = nextOf(req);
  if (sessionOf(req).session !== null) {
    res.redirect(303, siteUrl(site, next === 'checkout' ? '/checkout' : '/account'));
    return;
  }
  const challenge = pendingChallenge(site, appApprovalToken(req));
  if (challenge === null) {
    res.redirect(303, siteUrl(site, '/login'));
    return;
  }
  if (challenge.expiresAtMs <= Date.now()) {
    setAppApprovalCookie(res, site, null);
    sendPage(
      res,
      layout(
        site,
        'Sign-in request expired',
        `<h1>This sign-in request has expired</h1>
      <p><a href="${siteUrl(site, '/login')}${nextQuery(next)}">Sign in again</a></p>`
      ),
      410
    );
    return;
  }
  if (challenge.approvedAt !== null) {
    challenge.consumed = true;
    recordAttempt(site, 'second_factor', challenge.email, 'signed_in', null);
    setAppApprovalCookie(res, site, null);
    completeSignIn(res, site, startSession(site, challenge.email, 'password_app_approval'), next);
    return;
  }
  sendPage(
    res,
    layout(
      site,
      'Approve your sign-in',
      `<h1>Check your app</h1>
    <p>Your password was accepted for ${escapeHtml(challenge.email)}.</p>
    <p>Open Rose Authenticator on your phone. Enter <strong>${challenge.number}</strong> and approve this sign-in.</p>
    <p>This browser will continue once you approve the request in the app.</p>
    <p data-app-approval-status="pending">Waiting for your approval</p>
    <script>setTimeout(function () { location.reload(); }, 2000);</script>`
    )
  );
});

appApprovalRouter.get('/:siteId/device/approve', (req: Request, res: Response) => {
  const site = siteOf(req);
  if (!deviceAuthorized(req, site)) {
    devicePage(res, site, '<h1>This device is not registered</h1>', 403);
    return;
  }
  const challenge = deviceChallenge(site);
  if (challenge === null) {
    devicePage(res, site, '<h1>No sign-in request is waiting</h1>', 409);
    return;
  }
  if (challenge.expiresAtMs <= Date.now()) {
    devicePage(res, site, '<h1>This sign-in request has expired</h1>', 410);
    return;
  }
  renderDevice(res, site, challenge);
});

appApprovalRouter.post('/:siteId/device/approve', (req: Request, res: Response) => {
  const site = siteOf(req);
  if (!deviceAuthorized(req, site)) {
    devicePage(res, site, '<h1>This device is not registered</h1>', 403);
    return;
  }
  const challenge = pendingChallenge(site, formField(req, 'challenge'));
  if (challenge === null) {
    devicePage(res, site, '<h1>No sign-in request is waiting</h1>', 409);
    return;
  }
  if (challenge.expiresAtMs <= Date.now()) {
    recordAttempt(site, 'app_approval', challenge.email, 'rejected', 'expired_challenge');
    devicePage(res, site, '<h1>This sign-in request has expired</h1>', 410);
    return;
  }
  if (challenge.approvedAt !== null) {
    renderDevice(res, site, challenge);
    return;
  }
  if (!secretsEqual(formField(req, 'number').trim(), challenge.number)) {
    recordAttempt(site, 'app_approval', challenge.email, 'rejected', 'invalid_code');
    renderDevice(res, site, challenge, 'The number does not match the sign-in request.');
    return;
  }
  challenge.approvedAt = new Date().toISOString();
  recordAttempt(site, 'app_approval', challenge.email, 'approved', null);
  renderDevice(res, site, challenge);
});
