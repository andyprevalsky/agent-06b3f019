/**
 * Sign-up routes.
 *
 *   GET  /signup          account form (404-equivalent redirect when the site has no sign-up)
 *   POST /signup          create a pending account, email its code, 303 /signup/verify
 *   GET  /signup/verify   code entry;  POST verifies and signs in;  POST /signup/resend re-sends
 */

import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { AUTH_TEST_SITE_NAME } from './config';
import { siteUrl } from './service';
import { nextQuery } from './servicePages';
import { renderCodeEntryPage, renderSignUpPage } from './servicePagesCodes';
import { MIN_PASSWORD_LENGTH, sendSignUpCode, signUp, verifySignUp } from './serviceSignUp';
import { completeSignIn, formField, nextOf, queryField, sendPage, siteOf } from './routesShared';

export const signUpRouter = Router();

const SIGN_UP_ERRORS = {
  already_registered: 'An account with this email already exists. Sign in instead.',
  signup_unavailable: `We can't create new ${AUTH_TEST_SITE_NAME} accounts right now. Please try again later.`,
  invalid_details: `Enter a valid email address and a password of at least ${MIN_PASSWORD_LENGTH} characters.`,
} as const;

signUpRouter.get('/:siteId/signup', (req: Request, res: Response) => {
  const site = siteOf(req);
  if (site.behavior.signUp === 'off') {
    res.redirect(303, siteUrl(site, '/login'));
    return;
  }
  sendPage(res, renderSignUpPage(site, { next: nextOf(req) }));
});

signUpRouter.post(
  '/:siteId/signup',
  asyncHandler(async (req: Request, res: Response) => {
    const site = siteOf(req);
    const next = nextOf(req);
    if (site.behavior.signUp === 'off') {
      res.redirect(303, siteUrl(site, '/login'));
      return;
    }
    const name = formField(req, 'name');
    const email = formField(req, 'email').trim();
    const result = await signUp(site, { name, email, password: formField(req, 'password') });
    if (!result.ok) {
      sendPage(
        res,
        renderSignUpPage(site, { name, email, error: SIGN_UP_ERRORS[result.reason], next })
      );
      return;
    }
    res.redirect(
      303,
      `${siteUrl(site, '/signup/verify')}&email=${encodeURIComponent(email)}${nextQuery(next)}`
    );
  })
);

signUpRouter.get('/:siteId/signup/verify', (req: Request, res: Response) => {
  const site = siteOf(req);
  const email = queryField(req, 'email').trim();
  if (email === '') {
    res.redirect(303, siteUrl(site, '/signup'));
    return;
  }
  sendPage(res, renderCodeEntryPage(site, 'signup', { target: email, next: nextOf(req) }));
});

signUpRouter.post('/:siteId/signup/verify', (req: Request, res: Response) => {
  const site = siteOf(req);
  const email = formField(req, 'email');
  const next = nextOf(req);
  const result = verifySignUp(site, email, formField(req, 'code'));
  if (result.ok) {
    completeSignIn(res, site, result.token, next);
    return;
  }
  const error =
    result.reason === 'expired_code'
      ? 'That code has expired. Request a new one.'
      : 'That code is incorrect.';
  sendPage(res, renderCodeEntryPage(site, 'signup', { target: email, error, next }));
});

signUpRouter.post(
  '/:siteId/signup/resend',
  asyncHandler(async (req: Request, res: Response) => {
    const site = siteOf(req);
    const email = formField(req, 'email').trim();
    await sendSignUpCode(site, email);
    res.redirect(
      303,
      `${siteUrl(site, '/signup/verify')}&email=${encodeURIComponent(email)}${nextQuery(nextOf(req))}`
    );
  })
);
