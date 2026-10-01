/**
 * Sign-in behavior of the hosted site. Every attempt is appended to the site's
 * attempt log, which is what the benchmark evaluator reads back.
 *
 *   password ──► saved login on an unresolved ladder ──► rejections[n] | becomes the account
 *            ├─► unknown account / passwordless account / wrong password ──► rejected
 *            └─► match ──────────────────────────────────────────────────► session
 *   code req ──► unknown account ──► withheld (page wording is identical)
 *            ├─► account outside our mail domain ──► withheld (nothing can receive it)
 *            └─► minted inbox ──► Primitive send ──► code_sent | code_delivery_failed
 *   code     ──► unexpired, unconsumed, same email ──► session | rejected
 */

import { randomBytes, timingSafeEqual } from '../../providers/crypto';
import { primitiveDomain, sendPrimitiveEmail } from '../../providers/primitive';
import { createLogger } from '../../providers/logger';
import {
  AUTH_TEST_SITE_NAME,
  SIGN_IN_CODE_TTL_MS,
  SIGN_IN_EMAIL_SENDER_LOCAL_PART,
} from './config';
import type {
  AttemptKind,
  AttemptOutcome,
  AuthTestSite,
  CodeVerifyResult,
  PasswordSignInResult,
  RejectionReason,
  SignInMethod,
  SiteSession,
} from './types';

const log = createLogger('AuthTestSite');

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function secretsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function recordAttempt(
  site: AuthTestSite,
  kind: AttemptKind,
  email: string,
  outcome: AttemptOutcome,
  reason: RejectionReason
): void {
  site.attempts.push({ at: new Date().toISOString(), kind, email, outcome, reason });
  log.info('Sign-in attempt', { site_id: site.siteId, kind, email, outcome, reason });
}

function startSession(site: AuthTestSite, email: string, method: SignInMethod): string {
  const token = randomBytes(24).toString('base64url');
  site.sessions.push({ token, email, method, createdAt: new Date().toISOString(), endedAt: null });
  return token;
}

/** The rejection a ladder serves for this submission, or null to use the account table. */
function ladderRejection(
  site: AuthTestSite,
  email: string,
  password: string
): Exclude<RejectionReason, null> | null {
  const ladder = site.ladder;
  if (ladder === null) return null;
  const served = ladder.served.find((entry) => entry.email === email);
  if (served !== undefined) return served.reason;
  if (site.signInEmail !== null) return null;
  const login = ladder.logins.find(
    (candidate) => candidate.email === email && secretsEqual(candidate.password, password)
  );
  if (login === undefined) return null;
  const reason = ladder.rejections[ladder.served.length];
  if (reason !== undefined) {
    ladder.served.push({ email, reason });
    return reason;
  }
  site.accounts.push({ email, password: login.password, memberNumber: ladder.memberNumber });
  site.signInEmail = email;
  for (const record of site.savedPasswords) record.matchesAccount = record.username === email;
  return null;
}

function accountRejection(
  site: AuthTestSite,
  email: string,
  password: string
): Exclude<RejectionReason, null> | null {
  const account = site.accounts.find((candidate) => candidate.email === email);
  if (account === undefined) return 'unknown_account';
  if (account.password === null) return 'no_password';
  if (!secretsEqual(account.password, password)) return 'wrong_password';
  return null;
}

export function signInWithPassword(
  site: AuthTestSite,
  rawEmail: string,
  password: string
): PasswordSignInResult {
  const email = normalizeEmail(rawEmail);
  const reason = ladderRejection(site, email, password) ?? accountRejection(site, email, password);
  if (reason !== null) {
    recordAttempt(site, 'password', email, 'rejected', reason);
    return { ok: false, reason };
  }
  recordAttempt(site, 'password', email, 'signed_in', null);
  return { ok: true, token: startSession(site, email, 'password') };
}

function newSignInCode(): string {
  return String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

function signInEmailBody(code: string): string {
  return [
    `Your ${AUTH_TEST_SITE_NAME} sign-in code is ${code}`,
    '',
    'It expires in 10 minutes. If you did not ask to sign in, you can ignore this email.',
  ].join('\n');
}

export async function requestSignInCode(site: AuthTestSite, rawEmail: string): Promise<void> {
  const email = normalizeEmail(rawEmail);
  const account = site.accounts.find((candidate) => candidate.email === email);
  if (account === undefined) {
    recordAttempt(site, 'code_request', email, 'code_withheld', 'unknown_account');
    return;
  }
  if (!email.endsWith(`@${primitiveDomain().toLowerCase()}`)) {
    recordAttempt(site, 'code_request', email, 'code_withheld', null);
    return;
  }

  const code = newSignInCode();
  site.codes.push({ email, code, expiresAtMs: Date.now() + SIGN_IN_CODE_TTL_MS, consumed: false });
  const delivered = await sendPrimitiveEmail({
    from: `${AUTH_TEST_SITE_NAME} <${SIGN_IN_EMAIL_SENDER_LOCAL_PART}@${primitiveDomain()}>`,
    to: email,
    subject: `Your ${AUTH_TEST_SITE_NAME} sign-in code`,
    bodyText: signInEmailBody(code),
  });
  recordAttempt(
    site,
    'code_request',
    email,
    delivered ? 'code_sent' : 'code_delivery_failed',
    null
  );
}

export function verifySignInCode(
  site: AuthTestSite,
  rawEmail: string,
  rawCode: string
): CodeVerifyResult {
  const email = normalizeEmail(rawEmail);
  const code = rawCode.replace(/\D+/g, '');
  const nowMs = Date.now();
  const issued = site.codes.find(
    (candidate) =>
      candidate.email === email &&
      !candidate.consumed &&
      candidate.expiresAtMs > nowMs &&
      secretsEqual(candidate.code, code)
  );
  if (issued === undefined) {
    recordAttempt(site, 'code_verify', email, 'rejected', 'invalid_code');
    return { ok: false };
  }
  issued.consumed = true;
  recordAttempt(site, 'code_verify', email, 'signed_in', null);
  return { ok: true, token: startSession(site, email, 'email_code') };
}

export function findSession(site: AuthTestSite, token: string | null): SiteSession | null {
  if (token === null || token === '') return null;
  return (
    site.sessions.find(
      (session) => session.endedAt === null && secretsEqual(session.token, token)
    ) ?? null
  );
}

export function memberNumberFor(site: AuthTestSite, email: string): string | null {
  return site.accounts.find((account) => account.email === email)?.memberNumber ?? null;
}

/** Signing out ends the session but keeps it in the history the evaluator reads. */
export function endSession(site: AuthTestSite, token: string | null): void {
  const session = findSession(site, token);
  if (session !== null) session.endedAt = new Date().toISOString();
}
