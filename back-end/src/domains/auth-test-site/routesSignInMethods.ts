import { phoneSmsRetryAfterSeconds, phoneSmsTarget } from './servicePhoneSms';
/**
 * Sign-in methods other than the password form.
 *
 *   GET  /login/code            email form for a sign-in code (or link)
 *   POST /login/code            issue it (never reveals whether the account exists)
 *   GET  /login/code/verify     code entry;  POST verifies
 *   GET  /login/link/sent       "check your email";  GET /login/link?token= signs in
 *   GET  /login/sms             phone form;  POST texts a code
 *   GET  /login/sms/verify      code entry;  POST verifies
 *   POST /login/passkey/options WebAuthn request options (JSON)
 *   POST /login/passkey         WebAuthn assertion (JSON) -> { redirect } | { error }
 */

import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { publicSiteUrl, siteUrl } from './service';
import { requestSignInCode, verifySignInCode } from './serviceSignIn';
import {
  issuePasskeyChallenge,
  openSignInLink,
  recordPasskeyUnavailable,
  requestSignInLink,
  requestSmsCode,
  signInWithPasskey,
  verifySmsCode,
} from './serviceSignInMethods';
import { nextQuery, renderLoginPage } from './servicePages';
import {
  renderCodeEntryPage,
  renderCodeRequestPage,
  renderLinkSentPage,
  renderSmsRequestPage,
} from './servicePagesCodes';
import {
  completeSignIn,
  formField,
  landingUrl,
  nextOf,
  queryField,
  sendPage,
  setSessionCookie,
  siteOf,
} from './routesShared';

export const signInMethodsRouter = Router();

function codeError(reason: 'invalid_code' | 'expired_code'): string {
  return reason === 'expired_code'
    ? 'That code has expired. Request a new one.'
    : 'That code is incorrect.';
}

signInMethodsRouter.get('/:siteId/login/code', (req: Request, res: Response) => {
  const site = siteOf(req);
  if (site.behavior.emailSignIn === 'off') {
    res.redirect(303, siteUrl(site, '/login'));
    return;
  }
  sendPage(
    res,
    renderCodeRequestPage(site, { email: queryField(req, 'email'), next: nextOf(req) })
  );
});

signInMethodsRouter.post(
  '/:siteId/login/code',
  asyncHandler(async (req: Request, res: Response) => {
    const site = siteOf(req);
    const email = formField(req, 'email').trim();
    const next = nextOf(req);
    if (email === '' || site.behavior.emailSignIn === 'off') {
      res.redirect(303, siteUrl(site, '/login/code'));
      return;
    }
    const emailQuery = `&email=${encodeURIComponent(email)}${nextQuery(next)}`;
    if (site.behavior.emailSignIn === 'link') {
      await requestSignInLink(
        site,
        email,
        (token) => `${publicSiteUrl(site, '/login/link')}&token=${token}${nextQuery(next)}`
      );
      res.redirect(303, `${siteUrl(site, '/login/link/sent')}${emailQuery}`);
      return;
    }
    await requestSignInCode(site, email);
    res.redirect(303, `${siteUrl(site, '/login/code/verify')}${emailQuery}`);
  })
);

signInMethodsRouter.get('/:siteId/login/code/verify', (req: Request, res: Response) => {
  const site = siteOf(req);
  const email = queryField(req, 'email').trim();
  if (email === '') {
    res.redirect(303, siteUrl(site, '/login/code'));
    return;
  }
  sendPage(res, renderCodeEntryPage(site, 'sign_in', { target: email, next: nextOf(req) }));
});

signInMethodsRouter.post('/:siteId/login/code/verify', (req: Request, res: Response) => {
  const site = siteOf(req);
  const email = formField(req, 'email');
  const next = nextOf(req);
  const result = verifySignInCode(site, email, formField(req, 'code'));
  if (result.ok) {
    completeSignIn(res, site, result.token, next);
    return;
  }
  sendPage(
    res,
    renderCodeEntryPage(site, 'sign_in', { target: email, error: codeError(result.reason), next })
  );
});

signInMethodsRouter.get('/:siteId/login/link/sent', (req: Request, res: Response) => {
  const site = siteOf(req);
  sendPage(
    res,
    renderLinkSentPage(site, { email: queryField(req, 'email').trim(), next: nextOf(req) })
  );
});

signInMethodsRouter.get('/:siteId/login/link', (req: Request, res: Response) => {
  const site = siteOf(req);
  const result = openSignInLink(site, queryField(req, 'token'));
  if (result.ok) {
    completeSignIn(res, site, result.token, nextOf(req));
    return;
  }
  sendPage(res, renderLoginPage(site, { error: 'That sign-in link is invalid or has expired.' }));
});

signInMethodsRouter.get('/:siteId/login/sms', (req: Request, res: Response) => {
  const site = siteOf(req);
  if (site.behavior.smsSignIn === 'off') {
    res.redirect(303, siteUrl(site, '/login'));
    return;
  }
  sendPage(res, renderSmsRequestPage(site, { next: nextOf(req) }));
});

signInMethodsRouter.post(
  '/:siteId/login/sms',
  asyncHandler(async (req: Request, res: Response) => {
    const site = siteOf(req);
    const phone = phoneSmsTarget(site, formField(req, 'phone').trim());
    if (phone === '' || site.behavior.smsSignIn === 'off') {
      res.redirect(303, siteUrl(site, '/login/sms'));
      return;
    }
    const retryAfterSeconds = phoneSmsRetryAfterSeconds(site);
    if (retryAfterSeconds > 0) {
      res.setHeader('Retry-After', String(retryAfterSeconds));
      sendPage(
        res,
        '<p>Please wait before requesting another sign-in code, then try again.</p>',
        429
      );
      return;
    }
    await requestSmsCode(site, phone);
    res.redirect(
      303,
      `${siteUrl(site, '/login/sms/verify')}${site.scenario === 'phone_sms_otp' ? '' : `&phone=${encodeURIComponent(phone)}`}${nextQuery(nextOf(req))}`
    );
  })
);

signInMethodsRouter.get('/:siteId/login/sms/verify', (req: Request, res: Response) => {
  const site = siteOf(req);
  const phone = phoneSmsTarget(site, queryField(req, 'phone').trim());
  if (phone === '') {
    res.redirect(303, siteUrl(site, '/login/sms'));
    return;
  }
  sendPage(res, renderCodeEntryPage(site, 'sms', { target: phone, next: nextOf(req) }));
});

signInMethodsRouter.post('/:siteId/login/sms/verify', (req: Request, res: Response) => {
  const site = siteOf(req);
  const phone = formField(req, 'phone');
  const next = nextOf(req);
  const result = verifySmsCode(site, phone, formField(req, 'code'));
  if (result.ok) {
    completeSignIn(res, site, result.token, next);
    return;
  }
  sendPage(
    res,
    renderCodeEntryPage(site, 'sms', { target: phone, error: codeError(result.reason), next })
  );
});

signInMethodsRouter.post('/:siteId/login/passkey/options', (req: Request, res: Response) => {
  const options = issuePasskeyChallenge(siteOf(req));
  if (options === null) {
    res.status(404).json({ error: 'Passkeys are not available for this account.' });
    return;
  }
  res.setHeader('Cache-Control', 'no-store').json(options);
});

const PASSKEY_UNAVAILABLE =
  'We could not use a passkey in this browser. Try another way to sign in.';
const PASSKEY_REJECTED =
  'We could not sign you in with that passkey. It may have been removed from your account. Try another way to sign in.';

function textField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  return typeof value === 'string' ? value : '';
}

signInMethodsRouter.post('/:siteId/login/passkey', (req: Request, res: Response) => {
  const site = siteOf(req);
  const body = (req.body ?? {}) as Record<string, unknown>;
  res.setHeader('Cache-Control', 'no-store');
  if (body.unavailable === true) {
    recordPasskeyUnavailable(site);
    res.json({ error: PASSKEY_UNAVAILABLE });
    return;
  }
  const result = signInWithPasskey(site, {
    credentialId: textField(body, 'credentialId'),
    clientDataJSON: textField(body, 'clientDataJSON'),
    authenticatorData: textField(body, 'authenticatorData'),
    signature: textField(body, 'signature'),
  });
  if (!result.ok) {
    res.json({ error: PASSKEY_REJECTED });
    return;
  }
  setSessionCookie(res, site, result.token);
  res.json({ redirect: landingUrl(site, nextOf(req)) });
});
