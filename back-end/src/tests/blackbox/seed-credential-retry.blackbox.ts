#!/usr/bin/env tsx
/**
 * Blackbox: a transient browser-auth table failure must be retried IN PLACE,
 * never by re-running the whole credential graph.
 *
 * RCA cement (descend antibot, epoch 2). `browser-biometrics-webdecoy` declares
 * no `environment.live_cookie_domains`, so its live fixture runs the FULL
 * browser-auth graph under a 900s budget. On the bench guest:
 *
 *   ❌ LocalStorage credential sync failed:
 *      Invalid `remote.localStorageOrigin.findMany()` invocation
 *   ...      0/21177...  4500/21177...  13500/21177...
 *   ⚠ Credential sync timed out after 900s
 *   RuntimeError: fresh browser state scenario could not restore live browser credentials
 *
 * The task then sat `queued` for 1027s with 0 tokens and produced NO verdict
 * (controller: REAL NORESULT / INFRA_ERROR).
 *
 * Cause: `seed-local.ts:syncBrowserAuthWithRetries` retried at WHOLE-GRAPH
 * granularity. One transient remote read error on a late table (LocalStorage)
 * threw out of `syncBrowserAuthForCurrentMode()` and restarted everything from
 * the top — re-reading 21k cookies, 3.1k bundles, 3.7k localStorage origins and
 * the 38MB IndexedDB blob, up to 3 times. The same full graph completes in
 * ~2m53s locally on ONE pass, so the budget was consumed by redundant work, not
 * by the honest cost of the sync.
 *
 * The fix reduces work; it does not raise the budget. Retry the table that
 * actually failed, with the same bounded page sizes and the same fail-closed
 * contract.
 *
 *   case 1 — a transient table failure is retried in place until it succeeds.
 *   case 2 — retrying costs only that table's attempts, not a whole-graph replay.
 *   case 3 — a permanently failing table still fails closed, naming the table.
 *   case 4 — the whole-graph wrapper no longer multiplies the full sync.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import ts from 'typescript';
import { syncUserRecord } from '../../../scripts/seed-local-helpers';
import {
  CREDENTIAL_TABLE_SYNC_ATTEMPTS,
  syncRequiredCredentialTable,
} from '../../../scripts/seed-local-credentials';

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✅ ${label}`);
    return;
  }
  failures += 1;
  console.error(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
}

const noSleep = async (): Promise<void> => {};

async function case1TransientTableIsRetriedInPlace(): Promise<void> {
  let attempts = 0;
  const result = await syncRequiredCredentialTable(
    'LocalStorage',
    async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('remote.localStorageOrigin.findMany() failed');
      return 3732;
    },
    { sleep: noSleep }
  );
  check(
    'case 1: transient table failure is retried in place',
    result === 3732 && attempts === 3,
    `result=${result} attempts=${attempts}`
  );
}

async function case2RetryDoesNotReplayTheWholeGraph(): Promise<void> {
  // Model the real orchestration: cookies (expensive) then LocalStorage (flaky).
  let cookieReads = 0;
  let localStorageReads = 0;

  await syncRequiredCredentialTable(
    'Cookies',
    async () => {
      cookieReads += 1;
      return 21185;
    },
    { sleep: noSleep }
  );
  await syncRequiredCredentialTable(
    'LocalStorage',
    async () => {
      localStorageReads += 1;
      if (localStorageReads < 3) throw new Error('transient pooler error');
      return 3732;
    },
    { sleep: noSleep }
  );

  // Pre-fix, the whole-graph retry re-read the 21k-cookie table once per
  // attempt. That redundant work is what blew the 900s budget.
  check(
    'case 2: a flaky late table does not re-read the expensive earlier table',
    cookieReads === 1 && localStorageReads === 3,
    `cookieReads=${cookieReads} localStorageReads=${localStorageReads}`
  );
}

async function case3PermanentFailureStillFailsClosed(): Promise<void> {
  let attempts = 0;
  let message = '';
  try {
    await syncRequiredCredentialTable(
      'Passkey Credentials',
      async () => {
        attempts += 1;
        throw new Error('constraint violated');
      },
      { sleep: noSleep }
    );
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  check(
    'case 3: a permanently failing table fails closed and names the table',
    attempts === CREDENTIAL_TABLE_SYNC_ATTEMPTS &&
      message.includes('Passkey Credentials') &&
      message.includes('constraint violated'),
    `attempts=${attempts} message=${message}`
  );
}

function case4WholeGraphWrapperNoLongerMultiplies(): void {
  const seed = readFileSync(join(__dirname, '../../../scripts/seed-local.ts'), 'utf8');
  const match = seed.match(/const BROWSER_AUTH_SYNC_ATTEMPTS\s*=\s*(\d+)/);
  const attempts = match ? Number(match[1]) : NaN;
  check(
    'case 4: the whole-graph wrapper does not replay the full sync',
    attempts === 1,
    `BROWSER_AUTH_SYNC_ATTEMPTS=${match ? match[1] : 'not found'} (per-table retry owns transients now)`
  );
}

async function case5InitialAdmissionHasAnOwner(): Promise<void> {
  // Run the actual CLI orchestration, without importing its top-level clients
  // or starting a database. Only the database/credential edges are fixtures;
  // identity hydration and its bounded retry owner are the production helpers.
  const source = readFileSync(join(__dirname, '../../../scripts/seed-local.ts'), 'utf8');
  const ast = ts.createSourceFile('seed-local.ts', source, ts.ScriptTarget.ES2022, true);
  const functions = ast.statements.filter(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      ['ensureSeedUserExists', 'sync'].includes(node.name?.text ?? '')
  );
  if (functions.length !== 2) throw new Error('seed orchestration functions not found');
  const executable = ts.transpileModule(functions.map((node) => node.getText(ast)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;

  for (const mode of [
    'transient',
    'success',
    'permanent',
    'auth',
    'missing',
    'existing',
  ] as const) {
    let requests = 0;
    let userReads = 0;
    let credentialPasses = 0;
    let rejected = false;
    const userId = 'selected-seed-user';
    const foreign = { id: 'foreign-local-row', userId: 'foreign-user' };
    const users = new Map<
      string,
      { id: string; userId: string; phone?: string | null; name?: string }
    >([[foreign.userId, foreign]]);
    if (mode === 'existing') {
      users.set(userId, {
        id: 'frozen-local-row',
        userId,
        phone: '+15555550123',
        name: 'Frozen User',
      });
    }
    const admit = async () => {
      requests += 1;
      if (mode === 'permanent' || (mode === 'transient' && requests === 1)) {
        throw new Prisma.PrismaClientInitializationError(
          'FATAL: Max client connections reached',
          '5.20.0'
        );
      }
      if (mode === 'auth') {
        throw new Prisma.PrismaClientInitializationError('Authentication failed', '5.20.0');
      }
    };
    const bindings = {
      console: { log: () => {} },
      process: { env: { DATABASE_URL: 'postgresql://localhost/seed-fixture' } },
      REMOTE_URL: 'postgresql://localhost/remote-fixture',
      SEED_USER_ID: userId,
      SEED_COOKIE_DOMAINS: ['fixture.example'],
      COMPUTE_TOKENS_ONLY: false,
      PASSKEYS_ONLY: false,
      CREDENTIALS_ONLY: true,
      EMAIL_CREDENTIALS_ONLY: false,
      remote: {
        $queryRaw: admit,
        user: {
          findUnique: async ({ where }: { where: { userId: string } }) => {
            userReads += 1;
            if (where.userId !== userId) throw new Error('foreign remote identity read');
            await admit();
            return mode === 'missing'
              ? null
              : { id: 'remote-user-row', userId, phone: null, name: 'Remote User' };
          },
        },
      },
      local: {
        user: {
          upsert: async ({
            where,
            create,
            update,
          }: {
            where: { userId: string };
            create: { id: string; userId: string };
            update: { userId: string };
          }) => {
            if (where.userId !== userId) throw new Error('foreign local identity write');
            users.set(userId, { ...(users.get(userId) ?? create), ...update });
          },
        },
      },
      syncUserRecord,
      syncRequiredCredentialTable: <T>(name: string, operation: () => Promise<T>) =>
        syncRequiredCredentialTable(name, operation, { sleep: noSleep }),
      syncBrowserAuthWithRetries: async () => {
        if (!users.has(userId)) throw new Error('credentials reached before identity hydration');
        credentialPasses += 1;
      },
    };
    const sync = new Function(...Object.keys(bindings), `${executable}\nreturn sync;`)(
      ...Object.values(bindings)
    ) as () => Promise<void>;
    try {
      await sync();
    } catch {
      rejected = true;
    }
    const shouldSucceed = mode === 'transient' || mode === 'success' || mode === 'existing';
    const expectedReads =
      mode === 'success' || mode === 'existing' ? 1 : mode === 'transient' ? 2 : 3;
    check(
      `case 5 ${mode}: initial admission completes or fails closed within the identity owner`,
      rejected !== shouldSucceed &&
        userReads === expectedReads &&
        requests === expectedReads &&
        credentialPasses === Number(shouldSucceed) &&
        users.has(userId) === shouldSucceed &&
        users.get(foreign.userId) === foreign &&
        (mode !== 'existing' ||
          (users.get(userId)?.id === 'frozen-local-row' &&
            users.get(userId)?.phone === '+15555550123' &&
            users.get(userId)?.name === 'Frozen User')),
      `rejected=${rejected} requests=${requests} userReads=${userReads} credentialPasses=${credentialPasses}`
    );
  }
}

async function main(): Promise<void> {
  console.log('🔐 seed credential retry scope');
  await case1TransientTableIsRetriedInPlace();
  await case2RetryDoesNotReplayTheWholeGraph();
  await case3PermanentFailureStillFailsClosed();
  case4WholeGraphWrapperNoLongerMultiplies();
  await case5InitialAdmissionHasAnOwner();

  if (failures > 0) {
    console.error(`\n❌ seed credential retry scope: ${failures} case(s) failed`);
    process.exit(1);
  }
  console.log('\n✅ seed credential retry scope: all cases passed');
}

void main();
