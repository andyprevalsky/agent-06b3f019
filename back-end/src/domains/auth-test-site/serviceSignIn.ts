/**
 * Core sign-in behavior of the hosted site. Every attempt is appended to the
 * site's attempt log, which is what the benchmark evaluator reads back.
 *
 *   password ──► saved login on an unresolved ladder ──► rejections[n] | becomes the account
 *            ├─► locked / unknown / passwordless / wrong password ──► rejected
 *            ├─► match + second factor ──► pending (code emailed) ──► /login/verify
 *            └─► match ──────────────────────────────────────────► session
 *   code req ──► unknown or locked account ──► withheld (page wording is identical)
 *            ├─► address we cannot deliver to, or a site that never sends ──► withheld
 *            └─► deliverable inbox ──► Primitive send ──► code_sent | code_delivery_failed
 *   code     ──► unconsumed, same email + purpose ──► session | rejected (invalid | expired)
 *   cookie   ──► live session ──► resumed (logged once for a seeded session)
 *            └─► the user's saved-but-expired session ──► rejected (logged once)
 */

import { randomBytes, timingSafeEqual } from '../../providers/crypto';
import { primitiveDomain, sendPrimitiveEmail } from '../../providers/primitive';
import { createLogger } from '../../providers/logger';
import {
  AUTH_TEST_SITE_NAME,
  APP_APPROVAL_CHALLENGE_TTL_MS,
  SIGN_IN_CODE_TTL_MS,
  SIGN_IN_EMAIL_SENDER_LOCAL_PART,
} from './config';
import type {
  AttemptKind,
  AttemptOutcome,
  AuthTestSite,
  CodePurpose,
  CodeVerifyResult,
  PasswordSignInResult,
  RejectionReason,
  SignInMethod,
  SiteAccount,
  SiteSession,
} from './types';

const log = createLogger('AuthTestSite');

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function secretsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function recordAttempt(
  site: AuthTestSite,
  kind: AttemptKind,
  email: string,
  outcome: AttemptOutcome,
  reason: RejectionReason
): void {
  site.attempts.push({ at: new Date().toISOString(), kind, email, outcome, reason });
  log.info('Site event', { site_id: site.siteId, kind, email, outcome, reason });
}

export function startSession(
  site: AuthTestSite,
  email: string,
  method: SignInMethod,
  seeded = false
): string {
  const token = randomBytes(24).toString('base64url');
  site.sessions.push({
    token,
    email,
    method,
    createdAt: new Date().toISOString(),
    endedAt: null,
    seeded,
    resumed: false,
  });
  return token;
}

export function findAccount(site: AuthTestSite, email: string): SiteAccount | undefined {
  return site.accounts.find((candidate) => candidate.email === email);
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
  site.accounts.push({
    email,
    password: login.password,
    memberNumber: ladder.memberNumber,
    name: site.holderName,
    phone: null,
    locked: false,
    verified: true,
    origin: 'seed',
  });
  site.signInEmail = email;
  for (const record of site.savedPasswords) record.matchesAccount = record.username === email;
  return null;
}

function accountRejection(
  site: AuthTestSite,
  email: string,
  password: string
): Exclude<RejectionReason, null> | null {
  const account = findAccount(site, email);
  if (account === undefined || !account.verified) return 'unknown_account';
  if (account.locked) return 'locked';
  if (account.password === null) return 'no_password';
  if (!secretsEqual(account.password, password)) return 'wrong_password';
  return null;
}

function newCode(): string {
  return String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

/** Codes can only reach inboxes we can read back: the minted domain and the user's connected inbox. */
function deliverable(site: AuthTestSite, email: string): boolean {
  return email.endsWith(`@${primitiveDomain().toLowerCase()}`) || email === site.connectedInbox;
}

/**
 * Issues a code for the email and mails it. Returns the delivery outcome so
 * each caller logs it under its own attempt kind.
 */
export async function issueEmailCode(
  site: AuthTestSite,
  email: string,
  purpose: CodePurpose,
  wording: string
): Promise<'code_sent' | 'code_withheld' | 'code_delivery_failed'> {
  if (!deliverable(site, email)) return 'code_withheld';
  const firstOfPurpose = !site.codes.some((issued) => issued.purpose === purpose);
  const bornExpired = site.behavior.emailSignIn === 'code_first_expired' && firstOfPurpose;
  const code = newCode();
  site.codes.push({
    email,
    code,
    purpose,
    expiresAtMs: bornExpired ? Date.now() - 1 : Date.now() + SIGN_IN_CODE_TTL_MS,
    consumed: false,
  });
  const delivered = await sendPrimitiveEmail({
    from: `${AUTH_TEST_SITE_NAME} <${SIGN_IN_EMAIL_SENDER_LOCAL_PART}@${primitiveDomain()}>`,
    to: email,
    subject: `Your ${AUTH_TEST_SITE_NAME} ${wording} code`,
    bodyText: [
      `Your ${AUTH_TEST_SITE_NAME} ${wording} code is ${code}`,
      '',
      'It expires in 10 minutes. If you did not request it, you can ignore this email.',
    ].join('\n'),
  });
  return delivered ? 'code_sent' : 'code_delivery_failed';
}

/** Consumes a matching code. An expired match is reported as such, anything else as invalid. */
export function consumeCode(
  site: AuthTestSite,
  email: string,
  rawCode: string,
  purpose: CodePurpose
): 'ok' | 'invalid_code' | 'expired_code' {
  const code = rawCode.replace(/\D+/g, '');
  const issued = site.codes.find(
    (candidate) =>
      candidate.email === email &&
      candidate.purpose === purpose &&
      !candidate.consumed &&
      secretsEqual(candidate.code, code)
  );
  if (issued === undefined) return 'invalid_code';
  if (issued.expiresAtMs <= Date.now()) return 'expired_code';
  issued.consumed = true;
  return 'ok';
}

export async function signInWithPassword(
  site: AuthTestSite,
  rawEmail: string,
  password: string
): Promise<PasswordSignInResult> {
  const email = normalizeEmail(rawEmail);
  const reason = ladderRejection(site, email, password) ?? accountRejection(site, email, password);
  if (reason !== null) {
    recordAttempt(site, 'password', email, 'rejected', reason);
    return { ok: false, reason };
  }
  if (site.behavior.secondFactor === 'email_code') {
    recordAttempt(site, 'password', email, 'pending', null);
    const outcome = await issueEmailCode(site, email, 'second_factor', 'verification');
    recordAttempt(site, 'second_factor', email, outcome, null);
    return { ok: 'second_factor' };
  }
  if (site.behavior.secondFactor === 'app_approval') {
    recordAttempt(site, 'password', email, 'pending', null);
    const nowMs = Date.now();
    site.appApprovals = site.appApprovals
      .filter((challenge) => !challenge.consumed && challenge.expiresAtMs > nowMs)
      .slice(-15);
    const token = randomBytes(24).toString('base64url');
    site.appApprovals.push({
      token,
      email,
      number: site.appApprovalNumber,
      expiresAtMs: nowMs + APP_APPROVAL_CHALLENGE_TTL_MS,
      approvedAt: null,
      consumed: false,
    });
    recordAttempt(site, 'second_factor', email, 'pending', null);
    return { ok: 'app_approval', challengeToken: token };
  }
  recordAttempt(site, 'password', email, 'signed_in', null);
  return { ok: true, token: startSession(site, email, 'password') };
}

export function verifySecondFactor(
  site: AuthTestSite,
  rawEmail: string,
  rawCode: string
): CodeVerifyResult {
  const email = normalizeEmail(rawEmail);
  const result = consumeCode(site, email, rawCode, 'second_factor');
  if (result !== 'ok') {
    recordAttempt(site, 'second_factor', email, 'rejected', result);
    return { ok: false, reason: result };
  }
  recordAttempt(site, 'second_factor', email, 'signed_in', null);
  return { ok: true, token: startSession(site, email, 'password_email_2fa') };
}

/** Re-sends the second-factor code, but only to an email whose password was just accepted. */
export async function resendSecondFactor(site: AuthTestSite, rawEmail: string): Promise<void> {
  const email = normalizeEmail(rawEmail);
  const pending = site.codes.some(
    (issued) => issued.email === email && issued.purpose === 'second_factor'
  );
  if (!pending) return;
  const outcome = await issueEmailCode(site, email, 'second_factor', 'verification');
  recordAttempt(site, 'second_factor', email, outcome, null);
}

export async function requestSignInCode(site: AuthTestSite, rawEmail: string): Promise<void> {
  const email = normalizeEmail(rawEmail);
  const account = findAccount(site, email);
  if (account === undefined || !account.verified) {
    recordAttempt(site, 'code_request', email, 'code_withheld', 'unknown_account');
    return;
  }
  if (account.locked) {
    recordAttempt(site, 'code_request', email, 'code_withheld', 'locked');
    return;
  }
  if (site.behavior.emailSignIn === 'code_withheld') {
    recordAttempt(site, 'code_request', email, 'code_withheld', null);
    return;
  }
  const outcome = await issueEmailCode(site, email, 'sign_in', 'sign-in');
  recordAttempt(site, 'code_request', email, outcome, null);
}

export function verifySignInCode(
  site: AuthTestSite,
  rawEmail: string,
  rawCode: string
): CodeVerifyResult {
  const email = normalizeEmail(rawEmail);
  const result = consumeCode(site, email, rawCode, 'sign_in');
  if (result !== 'ok') {
    recordAttempt(site, 'code_verify', email, 'rejected', result);
    return { ok: false, reason: result };
  }
  recordAttempt(site, 'code_verify', email, 'signed_in', null);
  return { ok: true, token: startSession(site, email, 'email_code') };
}

/**
 * The session a request's cookie maps to. A seeded session is logged the first
 * time it is honored; the user's expired saved session is logged the first time
 * it is presented, and `expired` tells the page to say so.
 */
export function resolveSession(
  site: AuthTestSite,
  token: string | null
): { session: SiteSession | null; expired: boolean } {
  if (token === null || token === '') return { session: null, expired: false };
  const session =
    site.sessions.find(
      (candidate) => candidate.endedAt === null && secretsEqual(candidate.token, token)
    ) ?? null;
  if (session !== null) {
    if (session.seeded && !session.resumed) {
      session.resumed = true;
      recordAttempt(site, 'session', session.email, 'resumed', null);
    }
    return { session, expired: false };
  }
  const stale = site.staleSessionTokens.some((candidate) => secretsEqual(candidate, token));
  if (stale && !site.staleSessionSeen) {
    site.staleSessionSeen = true;
    recordAttempt(site, 'session', site.savedSessionEmail ?? '', 'rejected', 'expired_session');
  }
  return { session: null, expired: stale };
}

export function memberNumberFor(site: AuthTestSite, email: string): string | null {
  return findAccount(site, email)?.memberNumber ?? null;
}

/** Signing out ends the session but keeps it in the history the evaluator reads. */
export function endSession(site: AuthTestSite, session: SiteSession | null): void {
  if (session !== null) session.endedAt = new Date().toISOString();
}
