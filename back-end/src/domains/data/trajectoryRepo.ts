/** Indexed search over prior user-owned agent message trajectories. */

import { Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';
import type { AgentTrajectoryGrepFilters } from './types';

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
    // A prior trajectory is either a finalized archive or a terminal live run.
    // Concurrent active agents otherwise bury the older evidence in results.
    Prisma.sql`(s."archivePath" IS NOT NULL OR EXISTS (
      SELECT 1 FROM "Agent" root
      WHERE root.id = s."rootAgentId"
        AND root.status IN (
          'COMPLETED'::"AgentStatus", 'FAILED'::"AgentStatus",
          'OUT_OF_CREDITS'::"AgentStatus", 'COST_LIMIT_REACHED'::"AgentStatus"
        )
    ))`,
  ];
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
  query: Query & { limit: number; offset: number }
): Promise<AgentTrajectoryRow[]> {
  const predicate = where(query);
  return prisma.$queryRaw<AgentTrajectoryRow[]>`
    SELECT s."messageId", s."rootAgentId", s."agentId", s.role,
      s.surface, s."createdAt", s."searchText", s."agentGoal",
      s."agentTitle", s."archivePath", s."traceKind"
    FROM "AgentTrajectorySearch" s
    WHERE ${predicate}
    ORDER BY s."createdAt" DESC, s."messageId" DESC
    LIMIT ${query.limit + query.offset}
  `;
}
