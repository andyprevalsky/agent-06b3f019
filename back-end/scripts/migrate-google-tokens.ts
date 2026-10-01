import 'dotenv/config';

import { EmailProvider } from '@prisma/client';
import { prisma } from '../src/providers/database';
import { encryptGoogleToken, isGoogleTokenEncrypted } from '../src/providers/googleCredentials';

/** Backfill existing Gmail rows in bounded batches after the encryption code deploys. */
async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  let cursor: string | undefined;
  let pending = 0;
  let encrypted = 0;
  let raced = 0;

  while (true) {
    const rows = await prisma.emailIntegrationCredential.findMany({
      where: { provider: EmailProvider.GMAIL },
      select: { id: true, accessToken: true, refreshToken: true },
      orderBy: { id: 'asc' },
      take: 250,
      ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      const needsAccess = row.accessToken !== null && !isGoogleTokenEncrypted(row.accessToken);
      const needsRefresh = row.refreshToken !== null && !isGoogleTokenEncrypted(row.refreshToken);
      if (!needsAccess && !needsRefresh) continue;
      pending += 1;
      if (!apply) continue;

      const result = await prisma.emailIntegrationCredential.updateMany({
        where: {
          id: row.id,
          accessToken: row.accessToken,
          refreshToken: row.refreshToken,
        },
        data: {
          accessToken: needsAccess ? encryptGoogleToken(row.accessToken!) : row.accessToken,
          refreshToken: needsRefresh ? encryptGoogleToken(row.refreshToken!) : row.refreshToken,
        },
      });
      if (result.count === 1) encrypted += 1;
      else raced += 1;
    }
    cursor = rows[rows.length - 1].id;
  }

  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', pending, encrypted, raced }));
  if (raced > 0) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
