/**
 * In-call subscription lease source for Rose completions.
 *
 *   Rose subscription leg fails (limit / out of credits / auth)
 *        │ next(failure)
 *        ▼
 *   markComputeTokenUnavailable(failed)  ── provider reset time preserved
 *        │ exclude its pool id; remember it as tried
 *        ▼
 *   fetchComputeTokenForUser(userId, same lease options + exclusions)
 *        │ untried → served to the next subscription leg
 *        └ none / no progress → null → Rose continues to funded keys
 *
 * Bounded by the subscriptions that actually exist: every rotation marks and
 * excludes the failed credential, and a credential already tried in this call is
 * never served again. Lease options (tokenType, demo-cache affinity, lineage)
 * pass through unchanged, so a pinned call stays on its pinned provider. A
 * lineage lease is re-pointed in place, so the caller's existing release of that
 * lineage key releases whichever credential served last.
 */

import {
  fetchComputeTokenForUser,
  markComputeTokenUnavailable,
  type ComputeCodeCredentialResult,
} from './computeCredentials';
import { createLogger } from './logger';
import type {
  SubscriptionCredential,
  SubscriptionLeaseFailure,
  SubscriptionLeases,
} from './rose/types';

const log = createLogger('ComputeSubscriptionLeases');

type LeaseOptions = NonNullable<Parameters<typeof fetchComputeTokenForUser>[1]>;

/** Consecutive lookups that return only already-tried credentials before giving up. */
const MAX_LOOKUPS_WITHOUT_PROGRESS = 3;

export interface ComputeSubscriptionLeaseParams {
  userId: string;
  leaseOptions?: LeaseOptions;
  /** A credential the caller already leased and passes as claude_token/gpt_token. */
  initial?: ComputeCodeCredentialResult | null;
  fetchToken?: typeof fetchComputeTokenForUser;
  markToken?: typeof markComputeTokenUnavailable;
}

export function toSubscriptionCredential(
  token: ComputeCodeCredentialResult
): SubscriptionCredential {
  return token.type === 'gpt'
    ? { type: 'gpt', accessToken: token.accessToken, accountId: token.accountId }
    : { type: 'claude', accessToken: token.accessToken };
}

export function computeSubscriptionLeases(
  params: ComputeSubscriptionLeaseParams
): SubscriptionLeases {
  const fetchToken = params.fetchToken ?? fetchComputeTokenForUser;
  const markToken = params.markToken ?? markComputeTokenUnavailable;
  const leaseOptions = params.leaseOptions ?? {};
  const byAccessToken = new Map<string, ComputeCodeCredentialResult>();
  const triedAccessTokens = new Set<string>();
  const excludePoolTokenIds = [...(leaseOptions.excludePoolTokenIds ?? [])];
  let forcePool = leaseOptions.forcePool === true;

  const remember = (token: ComputeCodeCredentialResult) => {
    byAccessToken.set(token.accessToken, token);
    triedAccessTokens.add(token.accessToken);
  };
  if (params.initial) remember(params.initial);

  const recordFailure = async (failure: SubscriptionLeaseFailure) => {
    triedAccessTokens.add(failure.credential.accessToken);
    const token = byAccessToken.get(failure.credential.accessToken);
    if (token === undefined) return;
    if (token.source === 'pool' && token.poolTokenId) excludePoolTokenIds.push(token.poolTokenId);
    try {
      await markToken(token, failure.reason, failure.rateLimitedUntil);
    } catch (error) {
      log.warn('Could not mark subscription unavailable; excluding it for this call', {
        userId: params.userId,
        type: token.type,
        source: token.source,
        reason: failure.reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return {
    async next(failure) {
      if (failure !== null) await recordFailure(failure);
      for (let lookup = 0; lookup < MAX_LOOKUPS_WITHOUT_PROGRESS; lookup += 1) {
        const token = await fetchToken(params.userId, {
          ...leaseOptions,
          ...(forcePool ? { forcePool: true } : {}),
          ...(excludePoolTokenIds.length > 0
            ? { excludePoolTokenIds: [...excludePoolTokenIds] }
            : {}),
        });
        if (token === null) return null;
        const repeated = triedAccessTokens.has(token.accessToken);
        if (!repeated) {
          remember(token);
          return toSubscriptionCredential(token);
        }
        // A tried credential came back (its mark did not stick). Exclude it and
        // look again; user rows cannot be excluded by id, so move to the pool.
        if (token.source === 'pool' && token.poolTokenId)
          excludePoolTokenIds.push(token.poolTokenId);
        else forcePool = true;
      }
      return null;
    },
  };
}
