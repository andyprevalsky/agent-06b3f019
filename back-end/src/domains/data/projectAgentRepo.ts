/** Safe agent metadata in the reader's own projects and explicitly shared team projects. */
import { Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';

export interface ProjectAgentQuery {
  q?: string;
  projectId?: string;
  ownerUserId?: string;
  teamId?: string;
  offset: number;
  limit: number;
}

export interface ProjectAgentRow {
  id: string;
  title: string;
  status: string;
  projectId: string;
  projectName: string;
  ownerUserId: string;
  ownerName: string | null;
  updatedAt: Date;
  teamIds: string[];
}

function likeWord(word: string): string {
  return `%${word.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function wordPredicates(words: string[]): Prisma.Sql[] {
  return words.map(
    (word) => Prisma.sql`AND (COALESCE(a.title, '') || ' ' || p.name) ILIKE ${likeWord(word)}`
  );
}

function query(userId: string, input: ProjectAgentQuery) {
  // Own projects join only when a filter asks for them; a bare query adds just
  // teammates' shared projects (the caller's own tree covers its own agents).
  const includeOwn =
    input.projectId !== undefined || input.ownerUserId !== undefined || input.teamId !== undefined;
  const words = (input.q ?? '').split(/\s+/).filter((word) => word.length > 0);
  return Prisma.sql`
    FROM "Agent" a
    JOIN "Project" p ON p.id = a."projectId" AND p."userId" = a."userId"
    LEFT JOIN (
      "TeamProjectShare" s
      JOIN "TeamMember" reader ON reader."teamId" = s."teamId" AND reader."userId" = ${userId} AND reader.status = 'ACCEPTED'
      JOIN "TeamMember" owner ON owner."teamId" = s."teamId" AND owner."userId" = s."ownerUserId" AND owner.status = 'ACCEPTED'
    ) ON s."projectId" = p.id AND s."ownerUserId" = p."userId"
    WHERE a."deletedAt" IS NULL
      AND (s."teamId" IS NOT NULL ${includeOwn ? Prisma.sql`OR p."userId" = ${userId}` : Prisma.empty})
      ${input.teamId === undefined ? Prisma.empty : Prisma.sql`AND s."teamId" = ${input.teamId}`}
      ${input.ownerUserId === undefined ? Prisma.empty : Prisma.sql`AND p."userId" = ${input.ownerUserId}`}
      ${input.projectId === undefined ? Prisma.empty : Prisma.sql`AND p.id = ${input.projectId}`}
      ${words.length === 0 ? Prisma.empty : Prisma.join(wordPredicates(words), ' ')}
  `;
}

export async function listProjectAgentRows(userId: string, input: ProjectAgentQuery) {
  const from = query(userId, input);
  const [count, rows] = await Promise.all([
    prisma.$queryRaw<
      Array<{ count: bigint }>
    >`SELECT COUNT(DISTINCT a.id)::bigint AS count ${from}`,
    prisma.$queryRaw<ProjectAgentRow[]>`
      SELECT a.id, COALESCE(a.title, 'Untitled agent') AS title, a.status::text AS status,
        a."projectId", p.name AS "projectName", p."userId" AS "ownerUserId",
        (SELECT u.name FROM "User" u WHERE u."userId" = p."userId") AS "ownerName", a."updatedAt",
        COALESCE(array_agg(DISTINCT s."teamId") FILTER (WHERE s."teamId" IS NOT NULL), '{}') AS "teamIds"
      ${from}
      GROUP BY a.id, p.id
      ORDER BY a."updatedAt" DESC, a.id ASC
      LIMIT ${input.limit} OFFSET ${input.offset}
    `,
  ]);
  return { total: Number(count[0]?.count ?? 0), rows };
}
