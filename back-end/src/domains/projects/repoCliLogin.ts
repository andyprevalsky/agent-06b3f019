/**
 * ProjectCliLogin rows (cliLoginService.ts). Hashes only: the code and the
 * credential are never stored. The exchange is one conditional
 * `UPDATE … RETURNING`, so exactly one presentation of a code wins across
 * every backend instance. Tagged-template SQL is parameterized.
 */
import { prisma } from '../../providers/database';

export interface CliLoginRow {
  id: string;
  userId: string;
  projectId: string | null;
  codeHash: string;
  /** The code was still unexpired when this presentation burned it. */
  issued: boolean;
}

export interface CliCredentialRow {
  userId: string;
  projectId: string | null;
  credentialHash: string;
  credentialExpiresAt: Date;
}

/** Drop the caller's dead rows: unexchanged expired codes and expired credentials. */
export async function deleteDeadCliLogins(userId: string, now: Date): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM "ProjectCliLogin"
    WHERE "userId" = ${userId}
      AND (("credentialHash" IS NULL AND "codeExpiresAt" < ${now})
        OR "credentialExpiresAt" < ${now})`;
}

export async function insertCliLoginCode(row: {
  id: string;
  userId: string;
  projectId: string | null;
  codeHash: string;
  codeExpiresAt: Date;
}): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "ProjectCliLogin" ("id", "userId", "projectId", "codeHash", "codeExpiresAt")
    VALUES (${row.id}, ${row.userId}, ${row.projectId}, ${row.codeHash}, ${row.codeExpiresAt})`;
}

/**
 * Burn a code (first presentation wins, whatever the outcome) and, only when
 * it was still unexpired, attach the credential hash in the same statement.
 * null = unknown or already presented.
 */
export async function burnCliLoginCode(input: {
  codeHash: string;
  credentialHash: string;
  credentialExpiresAt: Date;
  now: Date;
}): Promise<CliLoginRow | null> {
  const rows = await prisma.$queryRaw<CliLoginRow[]>`
    UPDATE "ProjectCliLogin"
    SET "exchangedAt" = ${input.now},
        "credentialHash" = CASE WHEN "codeExpiresAt" > ${input.now}
                                THEN ${input.credentialHash} ELSE NULL END,
        "credentialExpiresAt" = CASE WHEN "codeExpiresAt" > ${input.now}
                                     THEN ${input.credentialExpiresAt} ELSE NULL END
    WHERE "codeHash" = ${input.codeHash} AND "exchangedAt" IS NULL
    RETURNING "id", "userId", "projectId", "codeHash",
              ("credentialHash" IS NOT NULL) AS "issued"`;
  return rows[0] ?? null;
}

export async function findLiveCliCredential(
  credentialHash: string,
  now: Date
): Promise<CliCredentialRow | null> {
  const rows = await prisma.$queryRaw<CliCredentialRow[]>`
    SELECT "userId", "projectId", "credentialHash", "credentialExpiresAt"
    FROM "ProjectCliLogin"
    WHERE "credentialHash" = ${credentialHash} AND "credentialExpiresAt" > ${now}
    LIMIT 1`;
  return rows[0] ?? null;
}
