/**
 * The claudeAuth attempt, including self-healing on a revoked grant.
 *
 * Extracted from `client.ts` so the orchestration there stays readable (and
 * within the file-size limit) while this file owns one decision: what to do when
 * the subscription path rejects our token.
 *
 * THE TRIGGER LIVES HERE. Grant liveness is observed from real traffic -- the
 * completion a user is already waiting on -- rather than from a scheduled
 * prober. That means zero extra provider calls, and the signal comes from the
 * exact path production uses.
 *
 * Recovery is deliberately conservative, because each wrong decision is
 * expensive in a different way:
 *   - re-minting on a THROTTLE would burn a grant on every rate limit;
 *   - re-minting on an unrecognised auth error would loop on a config bug;
 *   - NOT re-minting on a real revocation silently diverts every request onto
 *     paid models, which is the failure that motivated this work.
 * So it fires only on an explicit revocation verdict, only when the caller
 * identified the grant, only before any content has been emitted, and only once.
 */

import type { createLogger } from '../logger';
import { claudeAuthComplete } from './claudeAuth';
import { RoseAuthError, type RoseError } from './errors';
import { PreContentFallThroughError, runWithFallThrough } from './fallThroughStream';
import { tryRecoverGrant } from './grantRecovery';
import type { CompletionChunk, CompletionOptions, RoseStreamChunk } from './types';
import type { getPool } from './pools';

export interface ClaudeAuthAttemptParams {
  poolSpec: ReturnType<typeof getPool>;
  options: CompletionOptions;
  requestId: string;
  callSite: string;
  emit: (chunk: RoseStreamChunk) => CompletionChunk | null;
  log: ReturnType<typeof createLogger>;
}

/**
 * Run the claudeAuth path, healing once if the grant turns out to be revoked.
 *
 * Yields stream chunks. Returns `null` when the request was served (the caller
 * should finalize and stop), or the `RoseError` that should be recorded as the
 * claudeAuth failure before falling through to the waterfall.
 *
 * Non-fall-through errors are rethrown unchanged: those are real failures, not
 * a signal to try another provider.
 */
export async function* attemptClaudeAuthWithRecovery(
  params: ClaudeAuthAttemptParams
): AsyncGenerator<CompletionChunk, RoseError | null> {
  const { options, poolSpec, requestId, callSite, emit, log } = params;

  const produceWith = (token: string) => () =>
    claudeAuthComplete({
      poolSpec,
      messages: options.messages,
      responseFormat: options.response_format,
      tools: options.tools,
      toolChoice: options.tool_choice,
      maxTokens: options.max_tokens,
      temperature: options.temperature,
      effort: options.effort,
      auth: { mode: 'oauth', token },
      requestId,
      callSite,
      speed: options.speed,
    });

  try {
    yield* runWithFallThrough({ produce: produceWith(options.claude_token as string), emit });
    return null;
  } catch (err) {
    if (!(err instanceof PreContentFallThroughError)) throw err;

    const grant = options.compute_grant;
    const revoked = err.cause instanceof RoseAuthError && err.cause.grantRevoked;
    if (grant === undefined || !revoked) return err.cause;

    const recovery = await tryRecoverGrant({
      userId: grant.userId,
      provider: grant.provider,
      accountId: grant.accountId,
      grantId: grant.grantId,
      status: err.cause.status ?? 401,
      // The BODY carries the verdict; the status alone cannot distinguish a
      // revoked grant from any other auth failure.
      body: err.cause.message,
    });
    log.info('claude_auth.grant_recovery', {
      request_id: requestId,
      outcome: recovery?.status ?? 'no_hook',
      reason: recovery?.reason,
    });
    if (recovery?.accessToken === undefined) return err.cause;

    try {
      yield* runWithFallThrough({ produce: produceWith(recovery.accessToken), emit });
      log.info('claude_auth.done_after_remint', { request_id: requestId });
      return null;
    } catch (retryErr) {
      // Exactly ONE retry. A replacement that also fails means the grant was
      // never the problem, and looping would burn grants while the user waits.
      if (retryErr instanceof PreContentFallThroughError) return retryErr.cause;
      throw retryErr;
    }
  }
}
