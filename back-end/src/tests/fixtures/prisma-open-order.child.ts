#!/usr/bin/env tsx
// Child of seed-local-user.blackbox.ts. Reports whether the library engine's one-time
// openssl-probe (which setenv()s SSL_CERT_FILE on an engine thread) had already run when the
// second Prisma client was constructed: a client constructed earlier reads process.env while
// that probe may be writing it (getenv/setenv race, SIGSEGV in the seed).
import { PrismaClient } from '@prisma/client';
import { connectThenOpen } from '../../../scripts/seed-local-helpers';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const open = () => new PrismaClient({ datasources: { db: { url } } });

async function main(): Promise<void> {
  const first = open();
  let probedAtSecondOpen = false;
  const opened = () => {
    probedAtSecondOpen = process.env.SSL_CERT_FILE !== undefined;
    return open();
  };
  let second: PrismaClient;
  if (process.argv[2] === 'eager') {
    second = opened();
    await first.$connect();
  } else {
    second = await connectThenOpen(first, opened);
  }
  await second.$connect();
  process.stdout.write(
    JSON.stringify({ probedAtSecondOpen, probedAfter: process.env.SSL_CERT_FILE !== undefined }) +
      '\n'
  );
  await Promise.all([first.$disconnect(), second.$disconnect()]);
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack || error.message : String(error)}\n`
  );
  process.exit(1);
});
