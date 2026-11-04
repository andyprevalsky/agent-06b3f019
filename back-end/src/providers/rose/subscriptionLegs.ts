/**
 * Subscription legs of a Rose call: every Claude/Codex lease before any funded key.
 *
 *   caller tokens (claude_token, then gpt_token)
 *     └─ limit / out-of-credits / auth error before content
 *          └─ subscription_leases.next(failure)   marks it, leases an untried one
 *               └─ ... until next() returns null → client continues to funded keys
 *
 * Only typed errors rotate: RoseRateLimitError, RosePaymentRequiredError and
 * RoseAuthError. Any other pre-content failure keeps today's behaviour (try the
 * caller's other token, then funded keys). Errors after content stay terminal
 * because runWithFallThrough rethrows them unchanged. The lease source is never
 * consulted on the success path of a caller-supplied token, and only once for a
 * tokenless caller, so a healthy call costs no extra lease lookups.
 */

import type { createLogger } from '../logger';
import { attemptClaudeAuthWithRecovery } from './claudeAuthAttempt';
import {
  RoseAuthError,
  RosePaymentRequiredError,
  RoseRateLimitError,
  type RoseError,
} from './errors';
import { PreContentFallThroughError, runWithFallThrough } from './fallThroughStream';
import { gptAuthComplete } from './gptAuth';
import type { getPool } from './pools';
import type {
  CompletionChunk,
  CompletionOptions,
  RoseStreamChunk,
  SubscriptionCredential,
  SubscriptionLeaseFailure,
} from './types';

export interface SubscriptionLegParams {
  poolSpec: ReturnType<typeof getPool>;
  options: CompletionOptions;
  openAiToolFields: {
    responseFormat: CompletionOptions['response_format'];
    tools: CompletionOptions['tools'];
    toolChoice: CompletionOptions['tool_choice'];
  };
  requestId: string;
  callSite: string;
  emit: (chunk: RoseStreamChunk) => CompletionChunk | null;
  log: ReturnType<typeof createLogger>;
}

export interface SubscriptionLegResult {
  served: boolean;
  claudeAuthFailed: RoseError | null;
  gptAuthFailed: RoseError | null;
}

function callerCredentials(options: CompletionOptions): SubscriptionCredential[] {
  const credentials: SubscriptionCredential[] = [];
  if (options.claude_token) credentials.push({ type: 'claude', accessToken: options.claude_token });
  if (options.gpt_token) {
    credentials.push({
      type: 'gpt',
      accessToken: options.gpt_token,
      accountId: options.gpt_account_id,
    });
  }
  return credentials;
}

/** The existing typed limit/credit/auth signals; nothing else rotates. */
export function subscriptionLeaseFailure(
  credential: SubscriptionCredential,
  error: RoseError
): SubscriptionLeaseFailure | null {
  if (error instanceof RoseRateLimitError) {
    return { credential, reason: 'rate_limit', rateLimitedUntil: error.rateLimitedUntil };
  }
  if (error instanceof RosePaymentRequiredError) return { credential, reason: 'rate_limit' };
  if (error instanceof RoseAuthError) return { credential, reason: 'auth_error' };
  return null;
}

/** Yields chunks; returns null when served, otherwise the pre-content failure. */
async function* attemptCredential(
  params: SubscriptionLegParams,
  credential: SubscriptionCredential,
  fromCaller: boolean
): AsyncGenerator<CompletionChunk, RoseError | null> {
  const { options } = params;
  if (credential.type === 'claude') {
    return yield* attemptClaudeAuthWithRecovery({
      ...params,
      // A rotated lease is not the grant the caller identified, so it gets no re-mint.
      options: {
        ...options,
        claude_token: credential.accessToken,
        compute_grant: fromCaller ? options.compute_grant : undefined,
      },
    });
  }
  try {
    yield* runWithFallThrough({
      produce: () =>
        gptAuthComplete({
          poolSpec: params.poolSpec,
          messages: options.messages,
          ...params.openAiToolFields,
          temperature: options.temperature,
          effort: options.effort,
          gptToken: credential.accessToken,
          accountId: credential.accountId,
          requestId: params.requestId,
          callSite: params.callSite,
          speed: options.speed,
          abortSignal: options.abort_signal,
        }),
      emit: params.emit,
    });
    return null;
  } catch (err) {
    if (err instanceof PreContentFallThroughError) return err.cause;
    throw err;
  }
}

async function nextLease(
  params: SubscriptionLegParams,
  failure: SubscriptionLeaseFailure | null
): Promise<SubscriptionCredential | null> {
  const leases = params.options.subscription_leases;
  if (leases === undefined || params.options.abort_signal?.aborted === true) return null;
  try {
    return await leases.next(failure);
  } catch (error) {
    // A lease lookup failure degrades cost, never availability.
    params.log.warn('subscription.lease_failed', {
      request_id: params.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function* runSubscriptionLegs(
  params: SubscriptionLegParams
): AsyncGenerator<CompletionChunk, SubscriptionLegResult> {
  const result: SubscriptionLegResult = {
    served: false,
    claudeAuthFailed: null,
    gptAuthFailed: null,
  };
  const queue = callerCredentials(params.options);
  const fromCaller = new Set(queue);
  if (queue.length === 0) {
    const first = await nextLease(params, null);
    if (first !== null) queue.push(first);
  }

  let rotations = 0;
  for (let credential = queue.shift(); credential; credential = queue.shift()) {
    const failure = yield* attemptCredential(params, credential, fromCaller.has(credential));
    if (failure === null) {
      params.log.info(credential.type === 'claude' ? 'claude_auth.done' : 'gpt_auth.done', {
        request_id: params.requestId,
        pool: params.poolSpec.name,
        rotations,
        claude_auth_failed: result.claudeAuthFailed?.name ?? null,
      });
      result.served = true;
      return result;
    }
    if (credential.type === 'claude') result.claudeAuthFailed = failure;
    else result.gptAuthFailed = failure;
    params.log.info(`fall_through_from_${credential.type}_auth`, {
      request_id: params.requestId,
      reason: failure.name,
      rotations,
    });
    // The caller's own second token keeps its existing turn before any new lease.
    if (queue.length > 0) continue;
    const leaseFailure = subscriptionLeaseFailure(credential, failure);
    if (leaseFailure === null) break;
    const next = await nextLease(params, leaseFailure);
    if (next === null) break;
    rotations += 1;
    params.log.info('subscription.rotated', {
      request_id: params.requestId,
      from_type: credential.type,
      to_type: next.type,
      reason: leaseFailure.reason,
      rotations,
    });
    queue.push(next);
  }
  return result;
}
