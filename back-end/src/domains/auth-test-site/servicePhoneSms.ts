import {
  isLiveMessagingRuntime,
  isLocalBenchmarkSmsTransportMockEnabled,
} from '../../providers/smsTransportMock';
/** Account-bound challenge issuer metadata; never returns OTP material in reports. */
import { phoneCommandHash } from '../../providers/phoneHarnessCredentials';
import { randomBytes } from '../../providers/crypto';
import type { AuthTestSite, IssuedCode } from './types';
export function phoneSmsTarget(site: AuthTestSite, rawPhone: string) {
  return site.scenario === 'phone_sms_otp' ? (site.accounts[0]?.phone ?? '') : rawPhone;
}
export function initializePhoneChallenge(site: AuthTestSite, issued: IssuedCode) {
  if (site.scenario !== 'phone_sms_otp') return;
  for (const old of site.codes) if (old.purpose === 'sms') old.consumed = true;
  // A generated replacement is not usable until the canonical sender acknowledges it.
  issued.consumed = true;
  const challengeId = randomBytes(12).toString('hex');
  issued.phoneChallenge = {
    challengeId,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(issued.expiresAtMs).toISOString(),
    consumedAt: null,
    deliveryAck: false,
    liveTransport: isLiveMessagingRuntime() && !isLocalBenchmarkSmsTransportMockEnabled(),
    codeDigest: phoneCommandHash(
      'phone-sms-code',
      { siteId: site.siteId, challengeId, code: issued.code },
      'agent'
    ),
  };
}
export function phoneSmsNotice(site: AuthTestSite) {
  const challenge = site.codes.at(-1)?.phoneChallenge;
  const digits = (site.accounts[0]?.phone ?? '').replace(/\D/g, '');
  return `We texted a sign-in code to your registered phone ending ${digits.slice(-4)}. Request ${challenge?.challengeId ?? 'not-issued'}. It expires in 10 minutes.`;
}

/** A late success must not reactivate a challenge superseded by a newer request. */
export function acknowledgePhoneChallenge(
  site: AuthTestSite,
  issued: IssuedCode,
  success: boolean
) {
  if (issued.phoneChallenge === undefined) return;
  issued.phoneChallenge.deliveryAck = success;
  issued.consumed = !success || site.codes.at(-1) !== issued;
}
