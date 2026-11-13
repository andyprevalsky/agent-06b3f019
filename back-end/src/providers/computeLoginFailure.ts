/**
 * The one writer for a compute login a provider rejected: it disables a login
 * only when the report names it and the stored credential is still the live
 * token that was rejected (codeLoginRejection.ts).
 */
import {
  markPoolTokenRateLimited,
  markUserTokenRateLimited,
  storedClaudeLogin,
} from './claudeCredentials';
import {
  classifyLoginRejection,
  credentialFingerprint,
  type LoginRejection,
} from './codeLoginRejection';
import type { ComputeCodeCredentialResult, ComputeCodeCredentialType } from './computeCredentials';
import {
  markGptPoolTokenRateLimited,
  markGptUserTokenRateLimited,
  storedCodexLogin,
} from './gptCredentials';
import { prisma } from './database';
import { createLogger } from './logger';
import { subscriptionCooldownMeta } from './rose/subscriptionUsage';

const log = createLogger('ComputeCredentials');

/**
 * What a reported provider rejection of a leased login means for the stored
 * login now (codeLoginRejection.ts). A report that names no login cannot be
 * told apart from the user's other logins: it is `unverified` and disables none.
 */
export async function classifyReportedLogin(
  type: ComputeCodeCredentialType,
  integrationId: string | undefined,
  heldFingerprint: string | undefined
): Promise<LoginRejection> {
  if (integrationId === undefined || integrationId === '') return 'unverified';
  // An id this server does not hold as that kind of login (a guest's local id,
  // or a claude id reported as gpt) names nothing here: never disable by it.
  const row = await prisma.integration.findFirst({
    where: { id: integrationId, name: type === 'claude' ? 'claude_code' : 'gpt_code' },
    select: { id: true },
  });
  if (row === null) return 'unverified';
  const stored =
    type === 'claude'
      ? await storedClaudeLogin(integrationId)
      : await storedCodexLogin(integrationId);
  return classifyLoginRejection(stored, heldFingerprint);
}

/**
 * Back a compute token off after a failure.
 *
 * `rateLimitedUntil` is the PROVIDER's own reset time (from
 * `anthropic-ratelimit-*-reset` / `retry-after` / the error body). Pass it
 * whenever the provider supplied one: omitting it makes the cooldown fall back
 * to a synthetic 5-minute default, which is exactly how a real usage window got
 * destroyed in prod on 2026-07-28 — a header-derived `2026-07-30T22:00Z` was
 * overwritten 15s later by an uninformed `+5m` from this path. The synthetic
 * default is only correct when the provider genuinely told us nothing.
 */
export async function markComputeTokenUnavailable(
  token: ComputeCodeCredentialResult,
  reason: 'auth_error' | 'rate_limit',
  rateLimitedUntil?: string
): Promise<void> {
  const failureReason = reason === 'auth_error' ? 'auth_error' : undefined;
  // Why, and whether the provider gave this reset (vs Rose's default backoff):
  // the usage bar shows only an authoritative cooldown as an exhausted quota.
  const options = {
    failureReason,
    rateLimitedUntil,
    ...subscriptionCooldownMeta(token.accessToken, reason, rateLimitedUntil),
  };
  const integrationId = token.integrationId ?? token.poolTokenId;

  if (reason === 'auth_error') {
    // The caller holds the rejected token itself, so the comparison is exact.
    const rejection = await classifyReportedLogin(
      token.type,
      integrationId,
      credentialFingerprint(token.accessToken)
    );
    if (rejection !== 'revoked') {
      log.info('Rejected compute login not disabled', {
        type: token.type,
        source: token.source,
        integrationId: integrationId ?? null,
        rejection,
      });
      return;
    }
  }

  if (token.source === 'pool') {
    if (!token.poolTokenId) {
      log.warn('Cannot mark pool compute token unavailable without poolTokenId', {
        type: token.type,
        reason,
        userId: token.userId,
      });
      return;
    }
    if (token.type === 'claude') {
      await markPoolTokenRateLimited(token.poolTokenId, options);
      return;
    }
    await markGptPoolTokenRateLimited(token.poolTokenId, options);
    return;
  }

  // Pool branch returned above; remaining tokens are user-owned. Name the exact
  // leased row so a failure never reaches the user's other logins.
  const scope = { ...options, accountId: token.accountId, integrationId: token.integrationId };
  if (token.type === 'claude') {
    await markUserTokenRateLimited(token.userId, scope);
    return;
  }
  await markGptUserTokenRateLimited(token.userId, scope);
}
