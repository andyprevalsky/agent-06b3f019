/** Request helpers shared by the page routers. */

import type { Request, Response } from 'express';
import {
  APP_APPROVAL_COOKIE_NAME,
  AUTH_TEST_SITE_BASE_PATH,
  CART_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from './config';
import { siteUrl } from './service';
import { resolveSession } from './serviceSignIn';
import type { NextPage } from './servicePages';
import type { AuthTestSite, SiteSession } from './types';

export type SiteRequest = Request & { authTestSite?: AuthTestSite };

export function siteOf(req: Request): AuthTestSite {
  const site = (req as SiteRequest).authTestSite;
  if (site === undefined) throw new Error('auth test site missing from request');
  return site;
}

export function formField(req: Request, name: string): string {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const value = body[name];
  return typeof value === 'string' ? value : '';
}

export function queryField(req: Request, name: string): string {
  const value = req.query[name];
  return typeof value === 'string' ? value : '';
}

/** `next` may arrive in the query (links) or the form (posts); only the checkout is honored. */
export function nextOf(req: Request): NextPage {
  return queryField(req, 'next') === 'checkout' || formField(req, 'next') === 'checkout'
    ? 'checkout'
    : null;
}

function cookieValue(req: Request, cookieName: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name !== cookieName) continue;
    // A malformed sequence (`%E0`) must read as "no cookie", not a 500.
    try {
      return decodeURIComponent(rest.join('='));
    } catch {
      return null;
    }
  }
  return null;
}

function setCookie(res: Response, site: AuthTestSite, name: string, token: string | null): void {
  const path = `${AUTH_TEST_SITE_BASE_PATH}/${site.siteId}`;
  const value = token === null ? '' : encodeURIComponent(token);
  const expiry = token === null ? '; Max-Age=0' : '';
  res.append('Set-Cookie', `${name}=${value}; Path=${path}; HttpOnly; SameSite=Lax${expiry}`);
}

export function setSessionCookie(res: Response, site: AuthTestSite, token: string | null): void {
  setCookie(res, site, SESSION_COOKIE_NAME, token);
}

export function appApprovalToken(req: Request): string | null {
  return cookieValue(req, APP_APPROVAL_COOKIE_NAME);
}

export function setAppApprovalCookie(
  res: Response,
  site: AuthTestSite,
  token: string | null
): void {
  setCookie(res, site, APP_APPROVAL_COOKIE_NAME, token);
}

export function cartToken(req: Request): string | null {
  return cookieValue(req, CART_COOKIE_NAME);
}

export function setCartCookie(res: Response, site: AuthTestSite, token: string): void {
  setCookie(res, site, CART_COOKIE_NAME, token);
}

/** The request's live session, plus whether it presented the user's expired saved session. */
export function sessionOf(req: Request): { session: SiteSession | null; expired: boolean } {
  return resolveSession(siteOf(req), cookieValue(req, SESSION_COOKIE_NAME));
}

/** Sends a page and remembers which one it was: the site's last page is what the agent left open. */
export function sendPage(res: Response, html: string, status = 200): void {
  const site = (res.req as SiteRequest).authTestSite;
  if (site !== undefined) {
    site.lastPagePath = res.req.path.slice(`/${site.siteId}`.length) || '/';
  }
  res.status(status).type('html').setHeader('Cache-Control', 'no-store').send(html);
}

/** Where a completed sign-in lands. */
export function landingUrl(site: AuthTestSite, next: NextPage): string {
  return siteUrl(site, next === 'checkout' ? '/checkout' : '/account');
}

export function completeSignIn(
  res: Response,
  site: AuthTestSite,
  token: string,
  next: NextPage
): void {
  setSessionCookie(res, site, token);
  res.redirect(303, landingUrl(site, next));
}
