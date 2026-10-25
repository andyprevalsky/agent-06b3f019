/**
 * Data domain repo: raw SQL for grep over the messages of an agent tree.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';
import { pageSize, regexPredicate } from './sharedGrepRepo';

export interface AgentMessageGrepRow {
  id: string;
  text: string;
  role: 'SYSTEM' | 'ASSISTANT' | 'USER' | 'TOOL';
  agentId: string;
  createdAt: Date;
  metadata: Prisma.JsonValue | null;
  filePointer: Prisma.JsonValue | null;
  agentGoal: string;
  agentDepth: number;
  /** The agent's task path (/root/...); null for agents created before paths. */
  agentPath: string | null;
}

/** `filters.path` narrowing for agent_network: depth-N/<agentId>/<role>/<messageId>. */
function agentNetworkPathFilters(params: {
  pathAgentIds?: string[];
  pathAgentId?: string;
  pathRole?: string;
  pathMessageId?: string;
  role?: string;
}): Prisma.Sql {
  // A role/path filter must never expose SYSTEM, including legacy messages.
  const parts: Prisma.Sql[] = [Prisma.sql`AND m.role::text <> 'SYSTEM'`];
  if (params.pathAgentIds !== undefined && params.pathAgentIds.length > 0)
    parts.push(Prisma.sql`AND m."agentId" IN (${Prisma.join(params.pathAgentIds)})`);
  if (params.pathAgentId !== undefined)
    parts.push(Prisma.sql`AND m."agentId" = ${params.pathAgentId}`);
  if (params.pathRole !== undefined) parts.push(Prisma.sql`AND m.role::text = ${params.pathRole}`);
  if (params.role !== undefined) parts.push(Prisma.sql`AND m.role::text = ${params.role}`);
  if (params.pathMessageId !== undefined)
    parts.push(Prisma.sql`AND m.id = ${params.pathMessageId}`);
  return parts.length > 0 ? Prisma.join(parts, ' ') : Prisma.empty;
}

export async function countAgentNetworkGrepRows(params: {
  agentIds: string[];
  pattern: string;
  caseInsensitive: boolean;
  pathAgentIds?: string[];
  pathAgentId?: string;
  pathRole?: string;
  pathMessageId?: string;
  role?: string;
}): Promise<number> {
  if (params.agentIds.length === 0) return 0;
  const expression = Prisma.sql`(
    m.text || E'\n' || COALESCE(m.metadata::text, '') || E'\n' || COALESCE(m."filePointer"::text, '')
  )`;
  const predicate = regexPredicate(expression, params.pattern, params.caseInsensitive);
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM "Message" m
    WHERE m."agentId" IN (${Prisma.join(params.agentIds)})
      AND ${predicate}
      ${agentNetworkPathFilters(params)}
  `;
  return Number(rows[0]?.count ?? 0);
}

export async function searchAgentNetworkGrepRows(params: {
  agentIds: string[];
  pattern: string;
  caseInsensitive: boolean;
  limit: number;
  offset: number;
  pathAgentIds?: string[];
  pathAgentId?: string;
  pathRole?: string;
  pathMessageId?: string;
  role?: string;
  oldestFirst?: boolean;
}): Promise<AgentMessageGrepRow[]> {
  if (params.agentIds.length === 0) return [];
  const expression = Prisma.sql`(
    m.text || E'\n' || COALESCE(m.metadata::text, '') || E'\n' || COALESCE(m."filePointer"::text, '')
  )`;
  const predicate = regexPredicate(expression, params.pattern, params.caseInsensitive);
  return prisma.$queryRaw<AgentMessageGrepRow[]>`
    SELECT
      m.id,
      m.text,
      m.role::text AS role,
      m."agentId",
      m."createdAt",
      m.metadata,
      m."filePointer",
      a.goal AS "agentGoal",
      a.depth AS "agentDepth",
      CASE WHEN a."taskPath" IS NOT NULL THEN a."taskPath"
        WHEN a."parentAgentId" IS NULL THEN '/root' END AS "agentPath"
    FROM "Message" m
    INNER JOIN "Agent" a ON a.id = m."agentId"
    WHERE m."agentId" IN (${Prisma.join(params.agentIds)})
      AND ${predicate}
      ${agentNetworkPathFilters(params)}
    ORDER BY ${params.oldestFirst === true ? Prisma.sql`m."createdAt" ASC, m.id ASC` : Prisma.sql`m."createdAt" DESC, m.id DESC`}
    LIMIT ${pageSize(params.limit, params.offset)}
  `;
}
