/** Search only safe agent metadata in explicitly shared projects. */
import { Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';
import { regexPredicate, pageSize } from './sharedGrepRepo';
import type { ValidatedGrepInput } from './types';

function query(userId: string, input: ValidatedGrepInput) {
  const scope = input.teamScope;
  const filter = input.filters.projectAgents;
  const pattern = regexPredicate(
    Prisma.sql`COALESCE(a.title, 'Untitled agent') || E'\\n' || a.status::text || E'\\n' || p.name`,
    input.dbPattern,
    input.caseInsensitive
  );
  return Prisma.sql`
    FROM "TeamProjectShare" s
    JOIN "Project" p ON p.id = s."projectId" AND p."userId" = s."ownerUserId"
    JOIN "Agent" a ON a."projectId" = p.id AND a."userId" = p."userId" AND a."deletedAt" IS NULL
    JOIN "TeamMember" reader ON reader."teamId" = s."teamId" AND reader."userId" = ${userId} AND reader.status = 'ACCEPTED'
    JOIN "TeamMember" owner ON owner."teamId" = s."teamId" AND owner."userId" = p."userId" AND owner.status = 'ACCEPTED'
    WHERE ${pattern}
      ${scope.teamId === undefined ? Prisma.empty : Prisma.sql`AND s."teamId" = ${scope.teamId}`}
      ${scope.ownerUserId === undefined ? Prisma.empty : Prisma.sql`AND p."userId" = ${scope.ownerUserId}`}
      ${scope.scope === 'own' ? Prisma.sql`AND p."userId" = ${userId}` : Prisma.empty}
      ${scope.accountId === undefined ? Prisma.empty : Prisma.sql`AND FALSE`}
      ${filter?.agentId === undefined ? Prisma.empty : Prisma.sql`AND a.id = ${filter.agentId}`}
      ${filter?.projectId === undefined ? Prisma.empty : Prisma.sql`AND p.id = ${filter.projectId}`}
  `;
}

export interface SharedProjectAgentRow {
  id: string;
  title: string;
  status: string;
  projectId: string;
  projectName: string;
  ownerUserId: string;
  updatedAt: Date;
  teamIds: string[];
}
export async function searchSharedProjectAgentRows(userId: string, input: ValidatedGrepInput) {
  const from = query(userId, input);
  const [count, rows] = await Promise.all([
    prisma.$queryRaw<
      Array<{ count: bigint }>
    >`SELECT COUNT(DISTINCT a.id)::bigint AS count ${from}`,
    prisma.$queryRaw<SharedProjectAgentRow[]>`
      SELECT a.id, COALESCE(a.title, 'Untitled agent') AS title, a.status::text AS status,
        a."projectId", p.name AS "projectName", p."userId" AS "ownerUserId", a."updatedAt",
        array_agg(DISTINCT s."teamId") AS "teamIds"
      ${from}
      GROUP BY a.id, p.id
      ORDER BY a."updatedAt" DESC, p.id ASC, a.id ASC
      LIMIT ${pageSize(input.headLimit, input.offset)}
    `,
  ]);
  return { total: Number(count[0]?.count ?? 0), rows };
}
