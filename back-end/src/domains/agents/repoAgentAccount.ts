/** All account predicates are applied in SQL, before LIMIT or text projection. */
import { Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';
import type { AccountCursor } from '../../providers/agentGraph/pagination';

export interface AccountAgentRow {
  id: string;
  title: string | null;
  goal: string;
  status: string;
  projectId: string | null;
  folderId: string | null;
  createdAt: Date;
}
export interface AccountMessageRow {
  id: string;
  role: string;
  text: string;
  timestamp: Date;
  totalChars: number;
}

export async function accountAgentPage(
  userId: string,
  project: string | undefined,
  folder: string | undefined,
  cursor: AccountCursor,
  limit: number
): Promise<AccountAgentRow[]> {
  return prisma.$queryRaw<AccountAgentRow[]>(Prisma.sql`
    SELECT id, left(title, 160) AS title, left(goal, 300) AS goal, status::text,
      "projectId", "folderId", "createdAt"
    FROM "Agent" WHERE "userId"=${userId} AND "parentAgentId" IS NULL AND "deletedAt" IS NULL
      AND "createdAt" <= ${new Date(cursor.snapshot)}
      ${project === undefined ? Prisma.empty : Prisma.sql`AND "projectId"=${project}`}
      ${folder === undefined ? Prisma.empty : Prisma.sql`AND "folderId"=${folder}`}
      ${cursor.at === undefined ? Prisma.empty : Prisma.sql`AND ("createdAt",id)<(${new Date(cursor.at)},${cursor.id})`}
    ORDER BY "createdAt" DESC,id DESC LIMIT ${limit + 1}`);
}

export async function ownedAccountAgent(userId: string, id: string) {
  return prisma.agent.findFirst({
    where: { id, userId, deletedAt: null },
    select: {
      id: true,
      projectId: true,
      folderId: true,
      model: true,
      reasoningMaxTokens: true,
      fastModeCacheEnabled: true,
      memoryEnabled: true,
      worldModelMode: true,
      status: true,
      temporalWorkflowId: true,
      temporalWorkflowStartPending: true,
      priceLimitCents: true,
      parentAgentId: true,
    },
  });
}

/** Fetch at most 4001 Unicode codepoints per row, never a whole multi-MB body. */
export async function accountMessagePage(
  agentId: string,
  cursor: AccountCursor,
  limit: number
): Promise<AccountMessageRow[]> {
  return prisma.$queryRaw<AccountMessageRow[]>(Prisma.sql`
    SELECT id,role::text,left(text,4001) AS text,timestamp,char_length(text) AS "totalChars"
    FROM "Message" WHERE "agentId"=${agentId} AND timestamp <= ${new Date(cursor.snapshot)}
      ${cursor.at === undefined ? Prisma.empty : Prisma.sql`AND (timestamp,id)<(${new Date(cursor.at)},${cursor.id})`}
    ORDER BY timestamp DESC,id DESC LIMIT ${limit + 1}`);
}

export async function accountMessageSegment(agentId: string, id: string, offset: number) {
  const rows = await prisma.$queryRaw<AccountMessageRow[]>(Prisma.sql`
    SELECT id,role::text,substring(text FROM (${offset + 1})::integer FOR 4001) AS text,timestamp,
      char_length(text) AS "totalChars" FROM "Message" WHERE id=${id} AND "agentId"=${agentId}`);
  return rows[0] ?? null;
}

export async function ownedAccountPlacement(userId: string, project: string, folder: string) {
  return prisma.projectFolder.findFirst({
    where: { id: folder, projectId: project, project: { userId } },
    select: { id: true, projectId: true },
  });
}

export async function spawnRequestRecord(id: string) {
  return prisma.message.findFirst({
    where: { agentId: id, role: 'USER' },
    orderBy: { timestamp: 'asc' },
    select: { metadata: true },
  });
}
