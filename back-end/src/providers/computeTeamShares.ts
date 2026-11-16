/**
 * Team-shared compute subscriptions (docs/plans/active/share-all-integrations.md).
 *
 *   lease order (computeCredentials.ts): own → TEAM → pool → funded keys
 *
 * A teammate's claude_code / gpt_code account shared with one of the caller's
 * teams, resolved through the validated grant (accepted reader and owner,
 * CONNECTED row, exact compute account id) on every lease and every lease
 * reuse. The owner's own `rateLimitedUntil` applies to teammates too. Team
 * leases are keyed by the shared Integration id. Server-side Rose LLM calls
 * only: no sandbox (claudeCredentials / gptCredentials / e2b) or Mac
 * (localDevices) credential path reads these rows.
 *
 * 10k agents: one grant query and one indexed read per lease.
 */
import type { Integration } from '@prisma/client';
import { prisma } from './database';
import { resolveTeamDataAccess } from './teamAccess';

type TokenType = 'claude' | 'gpt';

function names(tokenType: TokenType | null): Array<'claude_code' | 'gpt_code'> {
  if (tokenType === 'claude') return ['claude_code'];
  if (tokenType === 'gpt') return ['gpt_code'];
  return ['claude_code', 'gpt_code'];
}

async function computeGrants(userId: string, tokenType: TokenType | null, integrationId?: string) {
  const allowed: string[] = names(tokenType);
  return (await resolveTeamDataAccess(userId)).filter(
    (grant) =>
      allowed.includes(grant.provider) &&
      grant.ownerUserId !== userId &&
      (integrationId === undefined || grant.integrationId === integrationId)
  );
}

/** Shared compute rows the user may lease now, least recently used first, with their team. */
export async function teamComputeIntegrations(
  userId: string,
  tokenType: TokenType | null,
  now: Date,
  onlyIntegrationId?: string
): Promise<Array<Integration & { teamId: string }>> {
  const grants = await computeGrants(userId, tokenType, onlyIntegrationId);
  if (grants.length === 0) return [];
  const rows = await prisma.integration.findMany({
    where: {
      id: { in: [...new Set(grants.map((grant) => grant.integrationId))] },
      name: { in: names(tokenType) },
      status: 'CONNECTED',
      OR: [{ rateLimitedUntil: null }, { rateLimitedUntil: { lt: now } }],
    },
    orderBy: [{ lastUsedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
  });
  return rows.flatMap((row) => {
    const grant = grants.find(
      (candidate) => candidate.integrationId === row.id && candidate.ownerUserId === row.userId
    );
    return grant === undefined ? [] : [{ ...row, teamId: grant.teamId }];
  });
}

/**
 * The owner of a compute account `userId` may currently lease through a team
 * (a cooldown report on a team lease lands on that owner's row), else null.
 */
export async function teamComputeOwner(
  userId: string,
  type: TokenType,
  integrationId: string
): Promise<string | null> {
  const [grant] = await computeGrants(userId, type, integrationId);
  return grant?.ownerUserId ?? null;
}
