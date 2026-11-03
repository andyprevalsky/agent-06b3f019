/**
 * SMS Supervisor compute-token fetching.
 *
 * Resolves the caller's claudeAuth / gpt compute token for direct-passthrough
 * completions. Always fails soft (returns null → the Rose waterfall handles the
 * call) so a token-fetch blip never crashes an inbound SMS. Split out of
 * supervisorHandler.ts to keep that file under its line budget.
 */

import { fetchComputeTokenForUser } from '../computeCredentials';
import { createLogger } from '../logger';

const log = createLogger('SmsSupervisor');

export interface SupervisorComputeToken {
  type: 'claude' | 'gpt';
  accessToken: string;
  accountId?: string;
}

/**
 * Benchmark-only compute-token type pin for supervisor model A/Bs
 * (BENCHMARK_SMS_SUPERVISOR_TOKEN_TYPE=claude|gpt). Unset in production.
 */
export function benchmarkSupervisorTokenType(): 'claude' | 'gpt' | undefined {
  const value = process.env.BENCHMARK_SMS_SUPERVISOR_TOKEN_TYPE;
  return value === 'claude' || value === 'gpt' ? value : undefined;
}

export async function getComputeToken(userId: string): Promise<SupervisorComputeToken | null> {
  try {
    const tokenType = benchmarkSupervisorTokenType();
    const computeToken = await fetchComputeTokenForUser(
      userId,
      tokenType === undefined ? undefined : { tokenType }
    );
    if (computeToken) {
      log.info('[SmsSupervisor] Using compute token', {
        userId,
        type: computeToken.type,
        source: computeToken.source,
        poolTokenId: computeToken.poolTokenId,
      });
      return {
        type: computeToken.type,
        accessToken: computeToken.accessToken,
        accountId: computeToken.accountId,
      };
    }

    log.info('[SmsSupervisor] No compute token available, will use waterfall', { userId });
    return null;
  } catch (error) {
    log.warn('[SmsSupervisor] Failed to fetch compute token, falling back to waterfall', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
