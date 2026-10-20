/**
 * Which root tasks count as real prod agent runs.
 *
 * One definition shared by the /biz-review task metrics and the 24h stuck-agent
 * bug reports, so "a real person's agent run" cannot drift between them:
 *
 *   root (no parent, depth 0) + not a benchmark + real world model
 *   + operator account or a real (non-fixture) person
 *   + at least one non-chat tool call (chat-only questions never enter the loop)
 */

import { Prisma } from '@prisma/client';
import { ADMIN_USER_IDS } from '../utils/adminAccess';
import { realWaitlistPersonSql } from './waitlistIdentity';

/** Chat-mode tool rows; an agent whose usage is only these never ran the agent loop. */
export const CHAT_ONLY_TOOL_NAMES = ['chat_router', 'chat_generator'] as const;

function column(alias: string, name: string): Prisma.Sql {
  return Prisma.raw(`"${alias}"."${name}"`);
}

/** Root, non-benchmark, real-world-model agent row. */
export function realRootAgentSql(agentAlias: string): Prisma.Sql {
  return Prisma.sql`${column(agentAlias, 'parentAgentId')} IS NULL
    AND ${column(agentAlias, 'depth')} = 0
    AND ${column(agentAlias, 'isBenchmark')} = false
    AND ${column(agentAlias, 'worldModelMode')} = 'real'`;
}

/** Operator account or a real person (joined "User" row aliased `personAlias`). */
export function realTaskOwnerSql(userIdSql: Prisma.Sql, personAlias: string): Prisma.Sql {
  return Prisma.sql`(${userIdSql} IN (${Prisma.join([...ADMIN_USER_IDS])})
    OR ${realWaitlistPersonSql(personAlias)})`;
}

/** The agent recorded at least one tool call outside chat mode. */
export function agentRanToolsSql(agentAlias: string): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "ToolUsage" usage
    WHERE usage."agentId" = ${column(agentAlias, 'id')}
      AND usage."toolName" NOT IN (${Prisma.join([...CHAT_ONLY_TOOL_NAMES])}))`;
}
