/**
 * Sign-up behavior. A new account stays unverified — and cannot sign in — until
 * the code emailed to its address is entered.
 *
 *   sign-up ──► site not taking sign-ups ──► rejected (signup_unavailable)
 *           ├─► email already has an account ──► rejected (already_registered)
 *           └─► pending account + emailed code ──► verify ──► verified + session
 */

import {
  issueEmailCode,
  consumeCode,
  findAccount,
  normalizeEmail,
  recordAttempt,
  startSession,
} from './serviceSignIn';
import { randomMemberNumber } from './serviceScenarios';
import type { AuthTestSite, CodeVerifyResult } from './types';

export const MIN_PASSWORD_LENGTH = 8;

export type SignUpResult =
  | { ok: true }
  | { ok: false; reason: 'already_registered' | 'signup_unavailable' | 'invalid_details' };

export async function signUp(
  site: AuthTestSite,
  input: { name: string; email: string; password: string }
): Promise<SignUpResult> {
  const email = normalizeEmail(input.email);
  if (site.behavior.signUp !== 'open') {
    recordAttempt(site, 'signup', email, 'rejected', 'signup_unavailable');
    return { ok: false, reason: 'signup_unavailable' };
  }
  if (!email.includes('@') || input.password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: 'invalid_details' };
  }
  const existing = findAccount(site, email);
  if (existing !== undefined && existing.verified) {
    recordAttempt(site, 'signup', email, 'rejected', 'already_registered');
    return { ok: false, reason: 'already_registered' };
  }
  if (existing === undefined) {
    site.accounts.push({
      email,
      password: input.password,
      memberNumber: randomMemberNumber(),
      name: input.name.trim() === '' ? null : input.name.trim(),
      phone: null,
      locked: false,
      verified: false,
      origin: 'signup',
    });
  } else {
    existing.password = input.password;
  }
  recordAttempt(site, 'signup', email, 'pending', null);
  await sendSignUpCode(site, email);
  return { ok: true };
}

export async function sendSignUpCode(site: AuthTestSite, rawEmail: string): Promise<void> {
  const email = normalizeEmail(rawEmail);
  const account = findAccount(site, email);
  if (account === undefined || account.verified) return;
  const outcome = await issueEmailCode(site, email, 'signup', 'verification');
  recordAttempt(site, 'signup_verify', email, outcome, null);
}

export function verifySignUp(
  site: AuthTestSite,
  rawEmail: string,
  rawCode: string
): CodeVerifyResult {
  const email = normalizeEmail(rawEmail);
  const account = findAccount(site, email);
  const result =
    account === undefined || account.verified
      ? 'invalid_code'
      : consumeCode(site, email, rawCode, 'signup');
  if (result !== 'ok' || account === undefined) {
    recordAttempt(
      site,
      'signup_verify',
      email,
      'rejected',
      result === 'ok' ? 'invalid_code' : result
    );
    return { ok: false, reason: result === 'ok' ? 'invalid_code' : result };
  }
  account.verified = true;
  if (site.signInEmail === null) site.signInEmail = email;
  recordAttempt(site, 'signup_verify', email, 'signed_in', null);
  return { ok: true, token: startSession(site, email, 'signup') };
}
