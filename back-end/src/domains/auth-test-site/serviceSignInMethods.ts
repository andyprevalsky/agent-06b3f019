import { phoneSmsTarget, initializePhoneChallenge } from './servicePhoneSms';
/**
 * The sign-in methods beyond password and emailed code. Each one appends to the
 * same attempt log the evaluator reads.
 *
 *   link req  ──► known, deliverable account ──► emailed link ──► GET /login/link ──► session
 *   sms req   ──► account with that phone ──► texted code ──► session
 *   passkey   ──► challenge ──► WebAuthn assertion ──► signature verified against the
 *                 seeded public key ──► session, or rejected when the site no longer
 *                 recognizes the passkey
 */

import { createHash, randomBytes, verify } from '../../providers/crypto';
import { primitiveDomain, sendPrimitiveEmail } from '../../providers/primitive';
import { sendSms } from '../../providers/smsQueue';
import { isLocalBenchmarkAgentPhoneMockEnabled } from '../../providers/smsTransportMock';
import * as repo from './repo';
import {
  AUTH_TEST_SITE_NAME,
  PASSKEY_CHALLENGE_TTL_MS,
  SIGN_IN_CODE_TTL_MS,
  SHOP_SMS_SENDER,
  SIGN_IN_EMAIL_SENDER_LOCAL_PART,
} from './config';
import {
  consumeCode,
  findAccount,
  normalizeEmail,
  recordAttempt,
  secretsEqual,
  startSession,
} from './serviceSignIn';
import type { AuthTestSite, CodeVerifyResult, SiteAccount, IssuedCode } from './types';

export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D+/g, '');
  return digits.length === 10 ? `1${digits}` : digits;
}

function accountByPhone(site: AuthTestSite, rawPhone: string): SiteAccount | undefined {
  const phone = normalizePhone(rawPhone);
  if (phone === '') return undefined;
  return site.accounts.find(
    (candidate) => candidate.phone !== null && normalizePhone(candidate.phone) === phone
  );
}

export async function requestSignInLink(
  site: AuthTestSite,
  rawEmail: string,
  linkFor: (token: string) => string
): Promise<void> {
  const email = normalizeEmail(rawEmail);
  const account = findAccount(site, email);
  if (account === undefined || !account.verified) {
    recordAttempt(site, 'link_request', email, 'code_withheld', 'unknown_account');
    return;
  }
  if (!email.endsWith(`@${primitiveDomain().toLowerCase()}`) && email !== site.connectedInbox) {
    recordAttempt(site, 'link_request', email, 'code_withheld', null);
    return;
  }
  const token = randomBytes(24).toString('base64url');
  site.linkTokens.push({
    token,
    email,
    expiresAtMs: Date.now() + SIGN_IN_CODE_TTL_MS,
    consumed: false,
  });
  const link = linkFor(token);
  const delivered = await sendPrimitiveEmail({
    from: `${AUTH_TEST_SITE_NAME} <${SIGN_IN_EMAIL_SENDER_LOCAL_PART}@${primitiveDomain()}>`,
    to: email,
    subject: `Sign in to ${AUTH_TEST_SITE_NAME}`,
    bodyText: [
      `Open this link to sign in to ${AUTH_TEST_SITE_NAME}:`,
      '',
      link,
      '',
      'It expires in 10 minutes and can be used once.',
    ].join('\n'),
    bodyHtml: `<p>Open this link to sign in to ${AUTH_TEST_SITE_NAME}:</p><p><a href="${link}">Sign in to ${AUTH_TEST_SITE_NAME}</a></p><p>It expires in 10 minutes and can be used once.</p>`,
  });
  recordAttempt(
    site,
    'link_request',
    email,
    delivered ? 'code_sent' : 'code_delivery_failed',
    null
  );
}

export function openSignInLink(
  site: AuthTestSite,
  token: string
): { ok: true; token: string } | { ok: false } {
  const issued = site.linkTokens.find(
    (candidate) =>
      !candidate.consumed &&
      candidate.expiresAtMs > Date.now() &&
      secretsEqual(candidate.token, token)
  );
  if (issued === undefined) {
    recordAttempt(site, 'link_open', '', 'rejected', 'invalid_code');
    return { ok: false };
  }
  issued.consumed = true;
  recordAttempt(site, 'link_open', issued.email, 'signed_in', null);
  return { ok: true, token: startSession(site, issued.email, 'magic_link') };
}

export async function requestSmsCode(site: AuthTestSite, rawPhone: string): Promise<void> {
  const account = accountByPhone(site, phoneSmsTarget(site, rawPhone));
  if (account === undefined || account.phone === null) {
    recordAttempt(
      site,
      'sms_request',
      normalizePhone(rawPhone),
      'code_withheld',
      'unknown_account'
    );
    return;
  }
  const code = String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, '0');
  const issued: IssuedCode = {
    email: account.email,
    code,
    purpose: 'sms' as const,
    expiresAtMs: Date.now() + SIGN_IN_CODE_TTL_MS,
    consumed: false,
  };
  initializePhoneChallenge(site, issued);
  site.codes.push(issued);
  const body = `Your ${AUTH_TEST_SITE_NAME} sign-in code is ${code}${issued.phoneChallenge ? ` (request ${issued.phoneChallenge.challengeId})` : ''}`;
  const sent = await sendSms(account.phone, body, { archiveContext: { source: 'auth-test-site' } });
  if (issued.phoneChallenge) issued.phoneChallenge.deliveryAck = sent.success;
  if (site.scenario !== 'phone_sms_otp' && isLocalBenchmarkAgentPhoneMockEnabled()) {
    await repo.deliverTextToMockPhone({
      userId: site.userId,
      externalId: `rose-shop-${randomBytes(12).toString('hex')}`,
      from: SHOP_SMS_SENDER,
      to: account.phone,
      body,
    });
  }
  recordAttempt(
    site,
    'sms_request',
    account.email,
    sent.success || (site.scenario !== 'phone_sms_otp' && isLocalBenchmarkAgentPhoneMockEnabled())
      ? 'code_sent'
      : 'code_delivery_failed',
    null
  );
}

export function verifySmsCode(
  site: AuthTestSite,
  rawPhone: string,
  rawCode: string
): CodeVerifyResult {
  const account = accountByPhone(site, phoneSmsTarget(site, rawPhone));
  const email = account?.email ?? normalizePhone(rawPhone);
  const result = account === undefined ? 'invalid_code' : consumeCode(site, email, rawCode, 'sms');
  if (result !== 'ok') {
    recordAttempt(site, 'sms_verify', email, 'rejected', result);
    return { ok: false, reason: result };
  }
  if (site.scenario === 'phone_sms_otp') {
    const issued = site.codes.find(
      (c) =>
        c.email === email &&
        c.code === rawCode.replace(/\D+/g, '') &&
        c.phoneChallenge !== undefined
    );
    if (issued?.phoneChallenge) issued.phoneChallenge.consumedAt = new Date().toISOString();
  }
  recordAttempt(site, 'sms_verify', email, 'signed_in', null);
  return { ok: true, token: startSession(site, email, 'sms_code') };
}

export interface PasskeyRequestOptions {
  challenge: string;
  rpId: string;
  allowCredentials: Array<{ type: 'public-key'; id: string }>;
}

export function issuePasskeyChallenge(site: AuthTestSite): PasskeyRequestOptions | null {
  if (site.passkey === null) return null;
  const challenge = randomBytes(32).toString('base64url');
  site.passkeyChallenges.push({ challenge, issuedAtMs: Date.now(), consumed: false });
  return {
    challenge,
    rpId: site.passkey.rpId,
    allowCredentials: [{ type: 'public-key', id: site.passkey.credentialId }],
  };
}

export interface PasskeyAssertion {
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}

const USER_PRESENT_FLAG = 0x01;

/** True when the assertion is a genuine signature by the seeded passkey over a live challenge. */
function assertionIsGenuine(site: AuthTestSite, assertion: PasskeyAssertion): boolean {
  const passkey = site.passkey;
  if (passkey === null || assertion.credentialId !== passkey.credentialId) return false;
  const clientDataBytes = Buffer.from(assertion.clientDataJSON, 'base64url');
  let clientData: { type?: unknown; challenge?: unknown; origin?: unknown };
  try {
    clientData = JSON.parse(clientDataBytes.toString('utf8')) as typeof clientData;
  } catch {
    return false;
  }
  const issued = site.passkeyChallenges.find(
    (candidate) =>
      !candidate.consumed &&
      Date.now() - candidate.issuedAtMs <= PASSKEY_CHALLENGE_TTL_MS &&
      candidate.challenge === clientData.challenge
  );
  if (issued === undefined) return false;
  issued.consumed = true;
  if (clientData.type !== 'webauthn.get' || clientData.origin !== site.publicOrigin) return false;
  const authenticatorData = Buffer.from(assertion.authenticatorData, 'base64url');
  if (authenticatorData.length < 37) return false;
  const rpIdHash = createHash('sha256').update(passkey.rpId).digest();
  if (!authenticatorData.subarray(0, 32).equals(rpIdHash)) return false;
  if ((authenticatorData[32] & USER_PRESENT_FLAG) === 0) return false;
  const signedBytes = Buffer.concat([
    authenticatorData,
    createHash('sha256').update(clientDataBytes).digest(),
  ]);
  return verify(
    'sha256',
    signedBytes,
    passkey.publicKeyPem,
    Buffer.from(assertion.signature, 'base64url')
  );
}

export function signInWithPasskey(
  site: AuthTestSite,
  assertion: PasskeyAssertion
): { ok: true; token: string } | { ok: false } {
  const email = site.passkey?.email ?? '';
  if (!assertionIsGenuine(site, assertion)) {
    recordAttempt(site, 'passkey', email, 'rejected', 'passkey_unavailable');
    return { ok: false };
  }
  if (site.behavior.passkey !== 'accept') {
    recordAttempt(site, 'passkey', email, 'rejected', 'passkey_not_recognized');
    return { ok: false };
  }
  recordAttempt(site, 'passkey', email, 'signed_in', null);
  return { ok: true, token: startSession(site, email, 'passkey') };
}

/** The browser could not produce an assertion (no authenticator, user dismissed it, ...). */
export function recordPasskeyUnavailable(site: AuthTestSite): void {
  recordAttempt(site, 'passkey', site.passkey?.email ?? '', 'rejected', 'passkey_unavailable');
}
