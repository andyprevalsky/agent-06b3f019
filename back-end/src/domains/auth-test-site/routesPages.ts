/**
 * Page routes for one hosted site (/:siteId/...).
 *
 *   GET  /            signed in ? 303 /account : welcome page
 *   GET  /login       sign-in form (password + link to emailed code)
 *   POST /login       password ok ? set cookie, 303 /account : form + generic error
 *   GET  /login/code  email form for a sign-in code
 *   POST /login/code  issue code (never reveals whether the account exists), 303 /login/code/verify
 *   GET  /login/code/verify   code entry form
 *   POST /login/code/verify   code ok ? set cookie, 303 /account : form + error
 *   GET  /account     signed in ? member details : 303 /login
 *   POST /logout      end session, 303 /
 *
 * GET pages missing this site's ?authRealm= are redirected to add it, so a
 * hand-typed URL still lands on the per-run credential realm.
 */

import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { AUTH_TEST_SITE_BASE_PATH, SESSION_COOKIE_NAME } from './config';
import { findSite, siteUrl } from './service';
import {
  endSession,
  findSession,
  memberNumberFor,
  requestSignInCode,
  signInWithPassword,
  verifySignInCode,
} from './serviceSignIn';
import {
  renderAccountPage,
  renderCodeEntryPage,
  renderCodeRequestPage,
  renderHomePage,
  renderLoginPage,
  renderNotFoundPage,
} from './servicePages';
import type { AuthTestSite } from './types';

export const pagesRouter = Router();

pagesRouter.use(express.urlencoded({ extended: false, limit: '16kb' }));

type SiteRequest = Request & { authTestSite?: AuthTestSite };

function siteOf(req: Request): AuthTestSite {
  const site = (req as SiteRequest).authTestSite;
  if (site === undefined) throw new Error('auth test site missing from request');
  return site;
}

function formField(req: Request, name: string): string {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const value = body[name];
  return typeof value === 'string' ? value : '';
}

function queryField(req: Request, name: string): string {
  const value = req.query[name];
  return typeof value === 'string' ? value : '';
}

function sessionToken(req: Request): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE_NAME) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function setSessionCookie(res: Response, site: AuthTestSite, token: string | null): void {
  const path = `${AUTH_TEST_SITE_BASE_PATH}/${site.siteId}`;
  const value = token === null ? '' : encodeURIComponent(token);
  const expiry = token === null ? '; Max-Age=0' : '';
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE_NAME}=${value}; Path=${path}; HttpOnly; SameSite=Lax${expiry}`
  );
}

function sendPage(res: Response, html: string, status = 200): void {
  res.status(status).type('html').setHeader('Cache-Control', 'no-store').send(html);
}

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

function redirectToAccountIfSignedIn(req: Request, res: Response): boolean {
  const site = siteOf(req);
  if (findSession(site, sessionToken(req)) === null) return false;
  res.redirect(303, siteUrl(site, '/account'));
  return true;
}

pagesRouter.get('/:siteId', (req: Request, res: Response) => {
  if (redirectToAccountIfSignedIn(req, res)) return;
  sendPage(res, renderHomePage(siteOf(req)));
});

pagesRouter.get('/:siteId/login', (req: Request, res: Response) => {
  if (redirectToAccountIfSignedIn(req, res)) return;
  sendPage(res, renderLoginPage(siteOf(req)));
});

pagesRouter.post('/:siteId/login', (req: Request, res: Response) => {
  const site = siteOf(req);
  const email = formField(req, 'email');
  const result = signInWithPassword(site, email, formField(req, 'password'));
  if (!result.ok) {
    sendPage(
      res,
      renderLoginPage(site, { email, error: 'The email or password you entered is incorrect.' })
    );
    return;
  }
  setSessionCookie(res, site, result.token);
  res.redirect(303, siteUrl(site, '/account'));
});

pagesRouter.get('/:siteId/login/code', (req: Request, res: Response) => {
  if (redirectToAccountIfSignedIn(req, res)) return;
  sendPage(res, renderCodeRequestPage(siteOf(req), { email: queryField(req, 'email') }));
});

pagesRouter.post(
  '/:siteId/login/code',
  asyncHandler(async (req: Request, res: Response) => {
    const site = siteOf(req);
    const email = formField(req, 'email').trim();
    if (email === '') {
      res.redirect(303, siteUrl(site, '/login/code'));
      return;
    }
    await requestSignInCode(site, email);
    res.redirect(303, `${siteUrl(site, '/login/code/verify')}&email=${encodeURIComponent(email)}`);
  })
);

pagesRouter.get('/:siteId/login/code/verify', (req: Request, res: Response) => {
  const site = siteOf(req);
  const email = queryField(req, 'email').trim();
  if (email === '') {
    res.redirect(303, siteUrl(site, '/login/code'));
    return;
  }
  sendPage(res, renderCodeEntryPage(site, { email }));
});

pagesRouter.post('/:siteId/login/code/verify', (req: Request, res: Response) => {
  const site = siteOf(req);
  const email = formField(req, 'email');
  const result = verifySignInCode(site, email, formField(req, 'code'));
  if (!result.ok) {
    sendPage(
      res,
      renderCodeEntryPage(site, { email, error: 'That code is incorrect or has expired.' })
    );
    return;
  }
  setSessionCookie(res, site, result.token);
  res.redirect(303, siteUrl(site, '/account'));
});

pagesRouter.get('/:siteId/account', (req: Request, res: Response) => {
  const site = siteOf(req);
  const session = findSession(site, sessionToken(req));
  if (session === null) {
    res.redirect(303, siteUrl(site, '/login'));
    return;
  }
  sendPage(res, renderAccountPage(site, session, memberNumberFor(site, session.email)));
});

pagesRouter.post('/:siteId/logout', (req: Request, res: Response) => {
  const site = siteOf(req);
  endSession(site, sessionToken(req));
  setSessionCookie(res, site, null);
  res.redirect(303, siteUrl(site));
});
