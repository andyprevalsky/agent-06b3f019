// Replay the singleton row another domain held while C15 resolved availability.
// Only this child process sees the row; never write a competing global fixture.
import { prisma } from '../../providers/database';

const findUnique = prisma.integration.findUnique.bind(prisma.integration);
prisma.integration.findUnique = ((args: Parameters<typeof findUnique>[0]) => {
  const key = args.where.userId_name_accountId;
  if (
    key?.userId === '00000000-0000-0000-0000-000000000000' &&
    key.name === 'codex_funded_cooldown' &&
    key.accountId === ''
  ) {
    return Promise.resolve({
      rateLimitedUntil: new Date(Date.now() + 2 * 60 * 60 * 1000),
      failureReason: 'codex_code_usage_limit',
    });
  }
  return findUnique(args);
}) as typeof prisma.integration.findUnique;
