/** Indexed search over prior user-owned agent message trajectories. */

import { Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';
import type { AgentTrajectoryGrepFilters } from './types';
import { buildAgentTrajectoryPath } from './path';
import { InvalidGrepParamError } from './errors';

export interface AgentTrajectoryRow {
  messageId: string;
  rootAgentId: string;
  agentId: string;
  role: 'USER' | 'ASSISTANT' | 'TOOL';
  surface: string;
  createdAt: Date;
  searchText: string;
  agentGoal: string;
  agentTitle: string | null;
  archivePath: string | null;
  traceKind: string;
  /** The agent's task path (/root/...) in its tree; null for pre-path or deleted agents. */
  agentPath: string | null;
}

interface Query {
  userId: string;
  excludeRootAgentId?: string;
  pattern: string;
  caseInsensitive: boolean;
  filters?: AgentTrajectoryGrepFilters;
}

function where(query: Query): Prisma.Sql {
  const filters = query.filters;
  const clauses: Prisma.Sql[] = [
    Prisma.sql`s."userId" = ${query.userId}`,
    // Keep this predicate even after the indexer is fixed: older derived rows
    // must never become visible through a path, role, or cursor query.
    Prisma.sql`s.role <> 'SYSTEM'`,
  ];
  // A prior trajectory is either a finalized archive or a terminal live run.
  // Concurrent active agents otherwise bury the older evidence in results. An
  // agent task path (/root/...) names the caller's own live tree explicitly.
  if (filters?.taskPath === undefined) {
    clauses.push(Prisma.sql`(s."archivePath" IS NOT NULL OR EXISTS (
      SELECT 1 FROM "Agent" root
      WHERE root.id = s."rootAgentId"
        AND root.status IN (
          'COMPLETED'::"AgentStatus", 'FAILED'::"AgentStatus",
          'OUT_OF_CREDITS'::"AgentStatus", 'COST_LIMIT_REACHED'::"AgentStatus"
        )
    ))`);
  }
  if (query.excludeRootAgentId !== undefined) {
    clauses.push(Prisma.sql`s."rootAgentId" <> ${query.excludeRootAgentId}`);
  }
  if (query.pattern) {
    clauses.push(
      query.caseInsensitive
        ? Prisma.sql`s."searchText" ~* ${query.pattern}`
        : Prisma.sql`s."searchText" ~ ${query.pattern}`
    );
  }
  if (filters?.pathRootAgentId !== undefined) {
    clauses.push(Prisma.sql`s."rootAgentId" = ${filters.pathRootAgentId}`);
  }
  if (filters?.pathAgentId !== undefined)
    clauses.push(Prisma.sql`s."agentId" = ${filters.pathAgentId}`);
  if (filters?.pathAgentIds !== undefined && filters.pathAgentIds.length > 0)
    clauses.push(Prisma.sql`s."agentId" IN (${Prisma.join(filters.pathAgentIds)})`);
  if (filters?.pathRole !== undefined) clauses.push(Prisma.sql`s.role = ${filters.pathRole}`);
  if (filters?.pathMessageId !== undefined)
    clauses.push(Prisma.sql`s."messageId" = ${filters.pathMessageId}`);
  if (filters?.role !== undefined) clauses.push(Prisma.sql`s.role = ${filters.role}`);
  if (filters?.surface !== undefined) clauses.push(Prisma.sql`s.surface = ${filters.surface}`);
  // Replayed LLM inputs are often copies of earlier messages. Keep direct
  // messages and model outputs in ordinary search; callers can request replay
  // context or the full corpus explicitly when that is the evidence they need.
  if (filters?.recordKind === undefined) {
    clauses.push(Prisma.sql`s."traceKind" <> 'llm_context'`);
  } else if (filters.recordKind !== 'all') {
    clauses.push(Prisma.sql`s."traceKind" = ${filters.recordKind}`);
  }
  if (filters?.since) clauses.push(Prisma.sql`s."createdAt" >= ${filters.since}`);
  if (filters?.until) clauses.push(Prisma.sql`s."createdAt" <= ${filters.until}`);
  return Prisma.join(clauses, ' AND ');
}

export async function countAgentTrajectories(query: Query): Promise<number> {
  const predicate = where(query);
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM "AgentTrajectorySearch" s
    WHERE ${predicate}
  `;
  return Number(rows[0]?.count ?? 0);
}

export async function hasTrajectoryRoot(userId: string, rootAgentId: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ found: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM "AgentTrajectorySearch"
      WHERE "userId" = ${userId} AND "rootAgentId" = ${rootAgentId}
    ) AS found
  `;
  return rows[0]?.found === true;
}

export async function searchAgentTrajectories(
  query: Query & {
    limit: number;
    offset: number;
    order: 'newest_first' | 'oldest_first';
    pageAfterMessageId?: string;
    pageAfterPath?: string;
    useKeyset: boolean;
  }
): Promise<AgentTrajectoryRow[]> {
  const predicate = where(query);
  let pagePredicate = Prisma.empty;
  if (query.pageAfterMessageId !== undefined) {
    const anchors = await prisma.$queryRaw<AgentTrajectoryRow[]>`
      SELECT s."messageId", s."rootAgentId", s."agentId", s.role, s."createdAt"
      FROM "AgentTrajectorySearch" s
      WHERE ${predicate} AND s."messageId" = ${query.pageAfterMessageId}
      LIMIT 1
    `;
    const anchor = anchors[0];
    if (
      anchor === undefined ||
      buildAgentTrajectoryPath(
        anchor.rootAgentId,
        anchor.agentId,
        anchor.role,
        anchor.messageId
      ) !== query.pageAfterPath
    ) {
      throw new InvalidGrepParamError('page_after');
    }
    pagePredicate =
      query.order === 'oldest_first'
        ? Prisma.sql`AND (s."createdAt", s."messageId") > (${anchor.createdAt}, ${anchor.messageId})`
        : Prisma.sql`AND (s."createdAt", s."messageId") < (${anchor.createdAt}, ${anchor.messageId})`;
  }
  const ordering =
    query.order === 'oldest_first'
      ? Prisma.sql`s."createdAt" ASC, s."messageId" ASC`
      : Prisma.sql`s."createdAt" DESC, s."messageId" DESC`;
  const take = query.useKeyset ? query.limit + 1 : query.limit + query.offset;
  return prisma.$queryRaw<AgentTrajectoryRow[]>`
    SELECT s."messageId", s."rootAgentId", s."agentId", s.role,
      s.surface, s."createdAt", s."searchText", s."agentGoal",
      s."agentTitle", s."archivePath", s."traceKind",
      CASE WHEN a.id IS NULL THEN NULL WHEN a."taskPath" IS NOT NULL THEN a."taskPath"
        WHEN a."parentAgentId" IS NULL THEN '/root' END AS "agentPath"
    FROM "AgentTrajectorySearch" s
    LEFT JOIN "Agent" a ON a.id = s."agentId"
    WHERE ${predicate} ${pagePredicate}
    ORDER BY ${ordering}
    LIMIT ${take}
  `;
}
