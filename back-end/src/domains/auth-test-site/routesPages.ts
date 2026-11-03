/**
 * Page routes for one hosted site (/:siteId/...). This file owns the site
 * lookup, the home page, password sign-in and the account page; the other
 * sign-in methods, sign-up and the shop live in sibling routers.
 *
 *   GET  /                shop ? catalog : signed in ? 303 /account : welcome
 *   GET  /login           sign-in form (or just the email step on an email-first site)
 *   POST /login/identify  email-first site: 303 /login/methods
 *   GET  /login/methods   every sign-in method for that email
 *   POST /login           ok ? cookie, 303 landing : second factor ? 303 /login/verify : form + error
 *   GET  /login/verify    second-factor code form;  POST verifies, POST /resend re-sends
 *   GET  /account         signed in ? member details and orders : 303 /login
 *   GET  /guest           guest page on sites that have one
 *   POST /logout          end session, 303 /
 *
 * GET pages missing this site's ?authRealm= are redirected to add it, so a
 * hand-typed URL still lands on the per-run credential realm.
 */

import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { findSite, siteUrl } from './service';
import {
  endSession,
  findAccount,
  memberNumberFor,
  recordAttempt,
  resendSecondFactor,
  signInWithPassword,
  verifySecondFactor,
} from './serviceSignIn';
import {
  renderAccountPage,
  renderGuestPage,
  renderLoginPage,
  renderMethodsPage,
  renderNotFoundPage,
  renderWelcomePage,
  nextQuery,
} from './servicePages';
import { renderCodeEntryPage } from './servicePagesCodes';
import { renderOrderHistory, renderShopPage } from './servicePagesShop';
import { cartLines, ordersFor } from './serviceShop';
import {
  cartToken,
  completeSignIn,
  formField,
  landingUrl,
  nextOf,
  queryField,
  sendPage,
  sessionOf,
  setSessionCookie,
  setAppApprovalCookie,
  siteOf,
  type SiteRequest,
} from './routesShared';
import { signInMethodsRouter } from './routesSignInMethods';
import { signUpRouter } from './routesSignUp';
import { shopRouter } from './routesShop';
import { appApprovalRouter } from './routesAppApproval';
import type { RejectionReason } from './types';

export const pagesRouter = Router();

pagesRouter.use(express.urlencoded({ extended: false, limit: '16kb' }));
pagesRouter.use(express.json({ limit: '32kb' }));

pagesRouter.use('/:siteId', (req: Request, res: Response, next: NextFunction) => {
  const site = findSite(req.params.siteId);
  if (site === null) {
    sendPage(res, renderNotFoundPage(), 404);
    return;
  }
  (req as SiteRequest).authTestSite = site;
  if (req.method === 'GET' && queryField(req, 'authRealm') !== site.realm) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(req.query)) {
      if (key !== 'authRealm' && typeof value === 'string') params.set(key, value);
    }
    const extra = params.toString();
    const suffix = req.path === '/' ? '/' : req.path.replace(/\/+$/, '');
    res.redirect(303, `${siteUrl(site, suffix)}${extra === '' ? '' : `&${extra}`}`);
    return;
  }
  next();
});

const EXPIRED_NOTICE = 'Your session has expired. Please sign in again.';

function passwordError(reason: Exclude<RejectionReason, null>): string {
  return reason === 'locked'
    ? 'This account is locked after too many failed sign-in attempts. Reset your password or contact support to unlock it.'
    : 'The email or password you entered is incorrect.';
}

pagesRouter.get('/:siteId', (req: Request, res: Response) => {
  const site = siteOf(req);
  const { session, expired } = sessionOf(req);
  if (expired) {
    setSessionCookie(res, site, null);
    sendPage(res, renderLoginPage(site, { notice: EXPIRED_NOTICE }));
    return;
  }
  if (site.behavior.shop) {
    const count = cartLines(site, cartToken(req)).reduce((sum, line) => sum + line.quantity, 0);
    sendPage(res, renderShopPage(site, session, count));
    return;
  }
  if (session !== null) {
    res.redirect(303, siteUrl(site, '/account'));
    return;
  }
  sendPage(res, renderWelcomePage(site));
});

pagesRouter.get('/:siteId/login', (req: Request, res: Response) => {
  const site = siteOf(req);
  const next = nextOf(req);
  const { session, expired } = sessionOf(req);
  if (session !== null) {
    res.redirect(303, landingUrl(site, next));
    return;
  }
  if (expired) setSessionCookie(res, site, null);
  const notice = expired || queryField(req, 'expired') === '1' ? EXPIRED_NOTICE : undefined;
  sendPage(res, renderLoginPage(site, { next, notice }));
});

pagesRouter.post('/:siteId/login/identify', (req: Request, res: Response) => {
  const site = siteOf(req);
  const email = formField(req, 'email').trim();
  const next = nextOf(req);
  if (email === '') {
    res.redirect(303, `${siteUrl(site, '/login')}${nextQuery(next)}`);
    return;
  }
  res.redirect(
    303,
    `${siteUrl(site, '/login/methods')}&email=${encodeURIComponent(email)}${nextQuery(next)}`
  );
});

pagesRouter.get('/:siteId/login/methods', (req: Request, res: Response) => {
  const site = siteOf(req);
  const email = queryField(req, 'email').trim();
  const next = nextOf(req);
  if (!site.behavior.identifierFirst || email === '') {
    res.redirect(303, `${siteUrl(site, '/login')}${nextQuery(next)}`);
    return;
  }
  sendPage(res, renderMethodsPage(site, { email, next }));
});

pagesRouter.post(
  '/:siteId/login',
  asyncHandler(async (req: Request, res: Response) => {
    const site = siteOf(req);
    const email = formField(req, 'email');
    const next = nextOf(req);
    const result = await signInWithPassword(site, email, formField(req, 'password'));
    if (result.ok === true) {
      completeSignIn(res, site, result.token, next);
      return;
    }
    if (result.ok === 'second_factor') {
      res.redirect(
        303,
        `${siteUrl(site, '/login/verify')}&email=${encodeURIComponent(email.trim())}${nextQuery(next)}`
      );
      return;
    }
    if (result.ok === 'app_approval') {
      setAppApprovalCookie(res, site, result.challengeToken);
      res.redirect(303, `${siteUrl(site, '/login/approve')}${nextQuery(next)}`);
      return;
    }
    const error = passwordError(result.reason);
    sendPage(
      res,
      site.behavior.identifierFirst
        ? renderMethodsPage(site, { email, error, next })
        : renderLoginPage(site, { email, error, next })
    );
  })
);

pagesRouter.get('/:siteId/login/verify', (req: Request, res: Response) => {
  const site = siteOf(req);
  const email = queryField(req, 'email').trim();
  if (email === '') {
    res.redirect(303, siteUrl(site, '/login'));
    return;
  }
  sendPage(res, renderCodeEntryPage(site, 'second_factor', { target: email, next: nextOf(req) }));
});

pagesRouter.post('/:siteId/login/verify', (req: Request, res: Response) => {
  const site = siteOf(req);
  const email = formField(req, 'email');
  const next = nextOf(req);
  const result = verifySecondFactor(site, email, formField(req, 'code'));
  if (result.ok) {
    completeSignIn(res, site, result.token, next);
    return;
  }
  const error =
    result.reason === 'expired_code'
      ? 'That code has expired. Request a new one.'
      : 'That code is incorrect.';
  sendPage(res, renderCodeEntryPage(site, 'second_factor', { target: email, error, next }));
});

pagesRouter.post(
  '/:siteId/login/verify/resend',
  asyncHandler(async (req: Request, res: Response) => {
    const site = siteOf(req);
    const email = formField(req, 'email').trim();
    await resendSecondFactor(site, email);
    res.redirect(
      303,
      `${siteUrl(site, '/login/verify')}&email=${encodeURIComponent(email)}${nextQuery(nextOf(req))}`
    );
  })
);

pagesRouter.get('/:siteId/account', (req: Request, res: Response) => {
  const site = siteOf(req);
  const { session, expired } = sessionOf(req);
  if (session === null) {
    res.redirect(303, `${siteUrl(site, '/login')}${expired ? '&expired=1' : ''}`);
    return;
  }
  const account = findAccount(site, session.email);
  const orders = site.behavior.shop ? ordersFor(site, { session, cartToken: null }) : [];
  sendPage(
    res,
    renderAccountPage(
      site,
      session,
      memberNumberFor(site, session.email),
      account?.name ?? null,
      renderOrderHistory(site, orders)
    )
  );
});

pagesRouter.get('/:siteId/guest', (req: Request, res: Response) => {
  const site = siteOf(req);
  if (site.behavior.guest === 'off') {
    res.redirect(303, siteUrl(site, '/login'));
    return;
  }
  if (site.behavior.shop) {
    res.redirect(303, siteUrl(site));
    return;
  }
  recordAttempt(site, 'guest', '', 'started', null);
  sendPage(res, renderGuestPage(site));
});

pagesRouter.post('/:siteId/logout', (req: Request, res: Response) => {
  const site = siteOf(req);
  endSession(site, sessionOf(req).session);
  setSessionCookie(res, site, null);
  res.redirect(303, siteUrl(site));
});

pagesRouter.use(signInMethodsRouter);
pagesRouter.use(appApprovalRouter);
pagesRouter.use(signUpRouter);
pagesRouter.use(shopRouter);
