import type { Prisma } from '@prisma/client';
import { deepStrictEqual } from 'node:assert';
import { prisma, createAnonSession, teardown } from './integrations.context';
import { testEmailGmailAccountDelete_removesOneCredential } from './integrations.email-credentials-2.cases';
import { cases } from './integration-accounts.pipelines.cases';

async function main() {
  const created = await createAnonSession();
  const owner = { token: created.accessToken, userId: created.userId };
  const original = prisma.googleDataPurge.findFirst;
  let invoked = false;
  let beforeJob: unknown;
  let afterJob: unknown;
  prisma.googleDataPurge.findFirst = (async (args: Prisma.GoogleDataPurgeFindFirstArgs) => {
    if (
      !invoked &&
      args?.where?.email === 'primary@gmail.com' &&
      typeof args.where.userId === 'string'
    ) {
      invoked = true;
      const userId = args.where.userId;
      const subject = { userId, name: 'gmail' };
      const snapshot = async () => {
        const row = await prisma.integration.findFirst({ where: subject });
        return {
          id: row?.id,
          userId: row?.userId,
          status: row?.status,
          isActive: row?.isActive,
          credentials: await prisma.emailIntegrationCredential.findMany({
            where: { userId },
            select: { id: true, email: true, state: true },
          }),
        };
      };
      beforeJob = await snapshot();
      process.stdout.write(`BOUNDARY before-sibling-job ${JSON.stringify(beforeJob)}\n`);
      await cases(() => owner)[0].fn();
      afterJob = await snapshot();
      process.stdout.write(`BOUNDARY after-sibling-job ${JSON.stringify(afterJob)}\n`);
    }
    return original(args);
  }) as typeof original;
  try {
    await testEmailGmailAccountDelete_removesOneCredential();
    if (!invoked) throw new Error('The post-DELETE controlled boundary was not exercised');
    deepStrictEqual(
      afterJob,
      beforeJob,
      'the sibling job must preserve the foreign integration and credential'
    );
    process.stdout.write(
      'PASS original Gmail account-delete assertion and owned Gmail sync assertions\n'
    );
    await cases(() => owner)[1].fn();
    process.stdout.write('PASS native failed-mailbox sibling control\n');
  } finally {
    prisma.googleDataPurge.findFirst = original;
    await teardown();
    await prisma.$disconnect();
  }
}
main().catch((e) => {
  process.stderr.write(`FAIL ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exitCode = 1;
});
