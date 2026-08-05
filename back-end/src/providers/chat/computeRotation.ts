import {
  fetchComputeTokenForUser,
  markComputeTokenUnavailable,
  type ComputeCodeCredentialResult,
} from '../computeCredentials';
import { createLogger } from '../logger';
import { RoseAuthError, RoseRateLimitError } from '../rose';

const log = createLogger('ChatComputeRotation');

export const CHAT_COMPUTE_MAX_ROTATIONS = 3;

export interface ChatComputeAuth {
  computeToken: ComputeCodeCredentialResult | null;
  claudeToken: string | null;
  gptToken: string | null;
  gptAccountId?: string;
}

export interface ChatComputeAttempt<T> {
  result: T;
  auth: ChatComputeAuth;
  rotations: number;
  usedWaterfall: boolean;
}

type ComputeTokenFailureReason = 'auth_error' | 'rate_limit';

export function toChatComputeAuth(
  computeToken: ComputeCodeCredentialResult | null
): ChatComputeAuth {
  if (computeToken?.type === 'claude') {
    return {
      computeToken,
      claudeToken: computeToken.accessToken,
      gptToken: null,
    };
  }
  if (computeToken?.type === 'gpt') {
    return {
      computeToken,
      claudeToken: null,
      gptToken: computeToken.accessToken,
      gptAccountId: computeToken.accountId,
    };
  }
  return {
    computeToken: null,
    claudeToken: null,
    gptToken: null,
  };
}

export async function fetchChatComputeAuth(userId: string): Promise<ChatComputeAuth> {
  if (process.env.CHAT_FORCE_WATERFALL === 'true') {
    log.warn('CHAT_FORCE_WATERFALL enabled; skipping chat compute token lookup', { userId });
    return toChatComputeAuth(null);
  }

  try {
    const token = await fetchComputeTokenForUser(userId);
    if (token) {
      log.info('Chat compute token selected', {
        userId,
        type: token.type,
        source: token.source,
        poolTokenId: token.poolTokenId,
      });
    }
    return toChatComputeAuth(token);
  } catch (error) {
    log.warn('Failed to fetch chat compute token; allowing waterfall', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return toChatComputeAuth(null);
  }
}

export async function callWithChatComputeRotation<T>(params: {
  userId: string;
  agentId: string;
  phase: string;
  initialAuth: ChatComputeAuth;
  invoke: (auth: ChatComputeAuth, options: { disableWaterfall: boolean }) => Promise<T>;
  fetchToken?: typeof fetchComputeTokenForUser;
  markToken?: typeof markComputeTokenUnavailable;
  maxRotations?: number;
}): Promise<ChatComputeAttempt<T>> {
  const fetchToken = params.fetchToken ?? fetchComputeTokenForUser;
  const markToken = params.markToken ?? markComputeTokenUnavailable;
  const maxRotations = params.maxRotations ?? CHAT_COMPUTE_MAX_ROTATIONS;
  const excludePoolTokenIds: string[] = [];
  let auth = params.initialAuth;
  let rotations = 0;

  if (!auth.computeToken) {
    return {
      result: await params.invoke(auth, { disableWaterfall: false }),
      auth,
      rotations,
      usedWaterfall: true,
    };
  }

  while (true) {
    try {
      return {
        result: await params.invoke(auth, { disableWaterfall: true }),
        auth,
        rotations,
        usedWaterfall: false,
      };
    } catch (error) {
      const reason = computeTokenFailureReason(error);
      if (!reason) {
        throw error;
      }

      const failedToken = auth.computeToken;
      if (!failedToken) {
        throw error;
      }

      await markToken(failedToken, reason, computeTokenRateLimitedUntil(error));
      if (failedToken.source === 'pool' && failedToken.poolTokenId) {
        excludePoolTokenIds.push(failedToken.poolTokenId);
      }

      if (rotations >= maxRotations) {
        const waterfallAuth = toChatComputeAuth(null);
        log.warn('Chat compute rotation exhausted; allowing waterfall', {
          userId: params.userId,
          agentId: params.agentId,
          phase: params.phase,
          maxRotations,
          failedType: failedToken.type,
          failedSource: failedToken.source,
        });
        return {
          result: await params.invoke(waterfallAuth, { disableWaterfall: false }),
          auth: waterfallAuth,
          rotations,
          usedWaterfall: true,
        };
      }

      const nextToken = await fetchToken(params.userId, {
        excludePoolTokenIds,
      });
      if (!nextToken) {
        const waterfallAuth = toChatComputeAuth(null);
        log.warn('No chat compute token available after rotation; allowing waterfall', {
          userId: params.userId,
          agentId: params.agentId,
          phase: params.phase,
          failedType: failedToken.type,
          failedSource: failedToken.source,
        });
        return {
          result: await params.invoke(waterfallAuth, { disableWaterfall: false }),
          auth: waterfallAuth,
          rotations,
          usedWaterfall: true,
        };
      }

      rotations += 1;
      auth = toChatComputeAuth(nextToken);
      log.info('Chat compute token rotated', {
        userId: params.userId,
        agentId: params.agentId,
        phase: params.phase,
        rotation: rotations,
        fromType: failedToken.type,
        fromSource: failedToken.source,
        toType: nextToken.type,
        toSource: nextToken.source,
        toPoolTokenId: nextToken.poolTokenId,
      });
    }
  }
}

function computeTokenFailureReason(error: unknown): ComputeTokenFailureReason | null {
  if (error instanceof RoseAuthError) return 'auth_error';
  if (error instanceof RoseRateLimitError) return 'rate_limit';
  return null;
}

/**
 * The provider's own reset time for the failed credential, when it gave one.
 * Undefined means the provider said nothing and the cooldown falls back to a
 * synthetic default — never let that default overwrite a real window.
 */
function computeTokenRateLimitedUntil(error: unknown): string | undefined {
  return error instanceof RoseRateLimitError ? error.rateLimitedUntil : undefined;
}
