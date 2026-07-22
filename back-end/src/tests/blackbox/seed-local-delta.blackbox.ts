#!/usr/bin/env tsx

import type { Cookie } from '@prisma/client';
import { syncCookieCredentials } from '../../../scripts/seed-local-credentials';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const revision = new Date('2026-07-20T21:22:51.000Z');
  const cookies: Cookie[] = Array.from({ length: 21_568 }, (_, index) => ({
    id: `remote-cookie-${index}`,
    userId: 'seed-user',
    domain: '.example.com',
    name: `session-${index}`,
    path: '/',
    value: `value-${index}`,
    expiresUtc: null,
    isSecure: true,
    isHttpOnly: true,
    browserSource: 'chrome',
    syncedAt: revision,
    creationUtc: null,
    hasExpires: false,
    isPersistent: false,
    lastAccessUtc: null,
    lastUpdateUtc: null,
    priority: 1,
    sameSite: 0,
    sourcePort: 443,
    sourceScheme: 2,
    topFrameSiteKey: '',
    browserProfile: 'Default',
  }));
  const localCookies = cookies.map((cookie) => ({
    ...cookie,
    syncedAt: new Date(revision.getTime() - 60_000),
  }));
  let upsertCalls = 0;
  const localModel = {
    findMany: async () => localCookies,
    upsert: async () => {
      upsertCalls += 1;
      return {};
    },
  };

  const syncedCount = await syncCookieCredentials(localModel, cookies);

  assert(
    syncedCount === cookies.length,
    `expected ${cookies.length} source rows, got ${syncedCount}`
  );
  assert(
    upsertCalls === 0,
    `expected unchanged live-fixture replay to issue 0 cookie upserts, got ${upsertCalls}`
  );
  console.log(
    `PASS unchanged ${cookies.length}-cookie live fixture issued ${upsertCalls} local upserts`
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
