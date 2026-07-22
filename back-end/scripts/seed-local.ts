/**
 * Sync user data from the remote (production) Supabase database to the local Postgres.
 *
 * Reads the remote DATABASE_URL from back-end/.env (since run.sh overrides
 * process.env.DATABASE_URL to point to local). Syncs all user-scoped data for
 * the dev user without overwriting locally-spawned agents.
 *
 * Usage: DATABASE_URL=<local_url> npx tsx scripts/seed-local.ts
 */

import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import dotenv from 'dotenv';
import {
  syncBrowserPasswordCredentials,
  syncBrowserPermissionCredentials,
  syncCookieBundleCredentials,
  syncCookieCredentials,
  syncIntegrationCredentials,
  syncOriginCredentials,
  syncPasskeyCredentialRows,
  syncRequiredCredentialTable,
  syncSteelSessionAuthCredentials,
} from './seed-local-credentials';
import { runSyncStep, syncRowsWithConcurrency, syncUserRecord } from './seed-local-helpers';
import {
  createScopedBrowserAuthReaders,
  parseCookieDomains,
  passkeySyncWhere,
} from './cookie-domain-scope';
import { selectRemoteDatabaseUrl } from './seed-remote-database-url';

const COMPUTE_TOKENS_ONLY = process.argv.includes('--compute-tokens-only');
const COMPUTE_TOKEN_SOURCE_DATABASE_URL =
  process.env.SEED_COMPUTE_TOKEN_SOURCE_DATABASE_URL?.trim();

if (COMPUTE_TOKENS_ONLY && !COMPUTE_TOKEN_SOURCE_DATABASE_URL) {
  throw new Error(
    '--compute-tokens-only requires SEED_COMPUTE_TOKEN_SOURCE_DATABASE_URL; refusing to fall back to .env'
  );
}

// Parse .env file directly to get remote DB URL
// (process.env.DATABASE_URL is already overridden to local by run.sh). Isolated
// benchmark runs may explicitly source compute tokens from the already-verified
// shared workspace DB so a production-side cooldown cannot invalidate a local
// deploy gate.
const envPath = resolve(__dirname, '..', '.env');
const envVars = COMPUTE_TOKENS_ONLY ? {} : dotenv.parse(readFileSync(envPath));
const REMOTE_URL = COMPUTE_TOKENS_ONLY
  ? COMPUTE_TOKEN_SOURCE_DATABASE_URL
  : selectRemoteDatabaseUrl(envVars);

if (!REMOTE_URL) {
  console.error('❌ No remote DATABASE_URL found in .env');
  process.exit(1);
}

const DEV_USER_ID = '1f85ff25-6e29-4c1b-8739-f917bd101a30';
// Merge production browser auth state into local by each table's natural
// identity. Matching rows are refreshed and missing production rows are added;
// local-only rows are deliberately preserved by normal/full sync. The explicit
// --passkeys-only benchmark mode is authoritative and removes stale local
// passkeys so its live-fixture preflight cannot succeed on obsolete material.
const CREDENTIALS_ONLY = process.argv.includes('--credentials-only');
const SKIP_BROWSER_AUTH_SYNC =
  process.env.BENCHMARK_SKIP_BROWSER_AUTH_SYNC === '1' ||
  process.env.BENCHMARK_WORLD_MODEL_MODE === 'simulate';
// Refresh ONLY the compute-token integrations (claude_code / gpt_code, the
// dev user's own + the shared pool) from prod. Benchmark runs invoke this at
// task setup so a frozen DB fixture or whole-DB snapshot restore can never
// leave the isolated DB with a stale/expired compute token — otherwise the
// agent's claudeAuth fetch fails and every LLM call falls through to the paid
// waterfall.
const PASSKEYS_ONLY = process.argv.includes('--passkeys-only');
const COMPUTE_TOKEN_SYNC_ATTEMPTS = 5;

// SEED_COOKIE_DOMAINS scopes every domain-bearing browser-auth table to the
// domains a benchmark task needs. Set by run_benchmark from the task's
// environment.live_cookie_domains. Empty → full browser-auth graph. Filter
// logic lives in cookie-domain-scope.ts and is pinned by blackbox coverage.
const SEED_COOKIE_DOMAINS = parseCookieDomains(process.env.SEED_COOKIE_DOMAINS);

const requestedSeedModes = [
  ['--compute-tokens-only', COMPUTE_TOKENS_ONLY],
  ['--passkeys-only', PASSKEYS_ONLY],
  ['--credentials-only', CREDENTIALS_ONLY],
].filter(([, enabled]) => enabled);
if (requestedSeedModes.length > 1) {
  throw new Error(
    `Seed modes are mutually exclusive; received ${requestedSeedModes
      .map(([flag]) => flag)
      .join(', ')}`
  );
}

const remote = new PrismaClient({ datasources: { db: { url: REMOTE_URL } } });
const local = new PrismaClient(); // uses process.env.DATABASE_URL (local)
const scopedRemoteBrowserAuth = createScopedBrowserAuthReaders(
  {
    cookie: (where) => remote.cookie.findMany({ where: where as never }),
    cookieBundle: (where) => remote.cookieBundle.findMany({ where: where as never }),
    steelSessionAuth: (where) => remote.steelSessionAuth.findMany({ where: where as never }),
    localStorageOrigin: (where) => remote.localStorageOrigin.findMany({ where: where as never }),
    indexedDBOrigin: (where) => remote.indexedDBOrigin.findMany({ where: where as never }),
    browserPermission: (where) => remote.browserPermission.findMany({ where: where as never }),
    cacheStorageOrigin: (where) => remote.cacheStorageOrigin.findMany({ where: where as never }),
    browserPassword: (where) => remote.browserPassword.findMany({ where: where as never }),
    passkeyCredential: (where) => remote.passkeyCredential.findMany({ where: where as never }),
  },
  DEV_USER_ID,
  SEED_COOKIE_DOMAINS
);

async function syncTable(name: string, fn: () => Promise<number>): Promise<void> {
  await runSyncStep(name, fn);
}

async function syncRequiredTable(
  name: string,
  fn: () => Promise<number>,
  failures?: Error[]
): Promise<void> {
  try {
    const count = await syncRequiredCredentialTable(name, fn);
    console.log(`  ✅ ${name}: ${count} synced`);
  } catch (err) {
    const failure = err instanceof Error ? err : new Error(String(err));
    console.error(`  ❌ ${failure.message}`);
    if (failures) {
      failures.push(failure);
      return;
    }
    throw failure;
  }
}

async function upsertById(model: any, records: any[]): Promise<number> {
  for (const r of records) {
    const { id, ...rest } = r;
    await model.upsert({ where: { id }, create: r, update: rest });
  }
  return records.length;
}

async function syncIntegrations(): Promise<number> {
  // Sync dev user's integrations + all pool tokens (needed for Claude Code benchmarks)
  const userIntegrations = await remote.integration.findMany({ where: { userId: DEV_USER_ID } });
  const poolIntegrations = await remote.integration.findMany({
    where: { poolingEnabled: true, userId: { not: DEV_USER_ID } },
  });
  const all = [...userIntegrations, ...poolIntegrations];
  // Pool tokens reference foreign users — ensure those User records exist locally
  const poolUserIds = [...new Set(poolIntegrations.map((i) => i.userId))];
  for (const uid of poolUserIds) {
    await syncUserRecord(remote.user, local.user, uid);
  }
  // Integrations are unique by (userId, name). A local credential may have a
  // different primary key from its production counterpart, so syncing by id
  // can collide with that compound key and fail every benchmark preflight.
  // Preserve the local id (and any dependent rows) while refreshing the
  // production credential fields.
  const syncedIds = await syncIntegrationCredentials(local.integration, all);
  const deleted = await local.integration.deleteMany({
    where: {
      name: { in: ['claude_code', 'gpt_code'] },
      id: { notIn: syncedIds.length > 0 ? syncedIds : ['__none__'] },
    },
  });
  if (deleted.count > 0) {
    console.log(`  🧹 Integrations: ${deleted.count} stale local compute tokens deleted`);
  }
  return syncedIds.length;
}

// Browser auth sync shared by full sync and --credentials-only. Natural-keyed
// credentials merge production rows; provider-profile mappings are replaced so
// their BrowserContext foreign key always points at the local context row.
async function syncBrowserState(failures?: Error[]): Promise<void> {
  // ── Browser Context ──
  await syncRequiredTable(
    'Browser Context',
    async () => {
      const ctx = await remote.browserContext.findUnique({ where: { userId: DEV_USER_ID } });
      if (!ctx) return 0;
      const { id, ...rest } = ctx;
      await local.browserContext.upsert({
        where: { userId: DEV_USER_ID },
        create: ctx as any,
        update: rest as any,
      });
      return 1;
    },
    failures
  );

  // ── Browser Provider Profiles ──
  // BrowserProviderProfile.contextId is a foreign key to BrowserContext.id.
  // The local context may intentionally retain a different primary key than
  // production, so replace the local mappings with rows remapped to that id.
  await syncRequiredTable(
    'Browser Provider Profiles',
    async () => {
      const remoteContext = await remote.browserContext.findUnique({
        where: { userId: DEV_USER_ID },
        select: { id: true },
      });
      const localContext = await local.browserContext.findUnique({
        where: { userId: DEV_USER_ID },
        select: { id: true },
      });
      if (!remoteContext || !localContext) return 0;
      const profiles = await remote.browserProviderProfile.findMany({
        where: { contextId: remoteContext.id },
      });
      await local.$transaction(async (tx) => {
        await tx.browserProviderProfile.deleteMany({ where: { contextId: localContext.id } });
        for (const profile of profiles) {
          const { id, contextId, ...data } = profile;
          void id;
          void contextId;
          await tx.browserProviderProfile.create({
            data: { ...data, contextId: localContext.id },
          });
        }
      });
      return profiles.length;
    },
    failures
  );

  // ── Cookies ──
  await syncRequiredTable(
    'Cookies',
    async () => {
      const cookies = await scopedRemoteBrowserAuth.cookie();
      if (SEED_COOKIE_DOMAINS.length > 0) {
        process.stdout.write(
          `     scoped to ${SEED_COOKIE_DOMAINS.length} domain(s) [${SEED_COOKIE_DOMAINS.join(
            ', '
          )}] → ${cookies.length} cookies\n`
        );
      }
      // Fresh local table (the benchmark cold path): one bulk createMany instead of
      // ~N per-row upsert round-trips (the ~780s bottleneck). On an already-populated
      // table (warm restore / re-sync) fall back to upsert so refreshed cookie values
      // overwrite stale rows. skipDuplicates makes the bulk path idempotent against
      // the natural-key unique constraint.
      const existingLocal = await local.cookie.count({ where: { userId: DEV_USER_ID } });
      if (existingLocal === 0 && cookies.length > 0) {
        for (let i = 0; i < cookies.length; i += 1000) {
          await local.cookie.createMany({
            data: cookies.slice(i, i + 1000) as never,
            skipDuplicates: true,
          });
        }
      } else {
        for (let i = 0; i < cookies.length; i += 500) {
          const batch = cookies.slice(i, i + 500);
          await syncCookieCredentials(local.cookie, batch);
          if (cookies.length > 500 && i + 500 < cookies.length) {
            process.stdout.write(
              `     ${Math.min(i + 500, cookies.length)}/${cookies.length}...\r`
            );
          }
        }
      }
      return cookies.length;
    },
    failures
  );

  // ── Durable browser-auth references ──
  await syncRequiredTable(
    'Cookie Bundles',
    async () => {
      const bundles = await scopedRemoteBrowserAuth.cookieBundle();
      return syncCookieBundleCredentials(local.cookieBundle, bundles);
    },
    failures
  );

  await syncRequiredTable(
    'Steel Session Auth',
    async () => {
      const sessions = await scopedRemoteBrowserAuth.steelSessionAuth();
      return syncSteelSessionAuthCredentials(local.steelSessionAuth, sessions);
    },
    failures
  );

  // ── LocalStorage Origins ──
  await syncRequiredTable(
    'LocalStorage',
    async () => {
      const origins = await scopedRemoteBrowserAuth.localStorageOrigin();
      return syncOriginCredentials(local.localStorageOrigin, origins);
    },
    failures
  );

  // ── IndexedDB Origins ──
  await syncRequiredTable(
    'IndexedDB',
    async () => {
      const origins = await scopedRemoteBrowserAuth.indexedDBOrigin();
      return syncOriginCredentials(local.indexedDBOrigin, origins);
    },
    failures
  );

  // ── Browser Permissions ──
  await syncRequiredTable(
    'Browser Permissions',
    async () => {
      const perms = await scopedRemoteBrowserAuth.browserPermission();
      return syncBrowserPermissionCredentials(local.browserPermission, perms);
    },
    failures
  );

  // ── Cache Storage Origins ──
  await syncRequiredTable(
    'Cache Storage',
    async () => {
      const caches = await scopedRemoteBrowserAuth.cacheStorageOrigin();
      return syncOriginCredentials(local.cacheStorageOrigin, caches);
    },
    failures
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasEncryptedCredentials(config: unknown): boolean {
  if (!config || typeof config !== 'object') return false;
  const encryptedCredentials = (config as Record<string, unknown>).encryptedCredentials;
  return typeof encryptedCredentials === 'string' && encryptedCredentials.length > 0;
}

interface GptCodeAvailability {
  // Connected, credentialed, bench-available, and NOT currently rate-limited.
  usable: number;
  // Connected, credentialed, bench-available, but throttled (rateLimitedUntil in
  // the future) — i.e. present but temporarily blocked by an external quota.
  rateLimited: number;
}

async function inspectGptCodeIntegrations(): Promise<GptCodeAvailability> {
  const now = new Date();
  const integrations = await local.integration.findMany({
    where: { name: 'gpt_code', status: 'CONNECTED' },
    select: {
      userId: true,
      poolingEnabled: true,
      config: true,
      rateLimitedUntil: true,
    },
  });

  const eligible = integrations.filter((integration) => {
    const isAvailableToBench = integration.userId === DEV_USER_ID || integration.poolingEnabled;
    return isAvailableToBench && hasEncryptedCredentials(integration.config);
  });

  let usable = 0;
  let rateLimited = 0;
  for (const integration of eligible) {
    if (integration.rateLimitedUntil !== null && integration.rateLimitedUntil > now) {
      rateLimited += 1;
    } else {
      usable += 1;
    }
  }
  return { usable, rateLimited };
}

async function countUsableClaudeCodeIntegrations(): Promise<number> {
  const now = new Date();
  const integrations = await local.integration.findMany({
    where: {
      name: 'claude_code',
      status: 'CONNECTED',
      OR: [{ rateLimitedUntil: null }, { rateLimitedUntil: { lt: now } }],
    },
    select: {
      userId: true,
      poolingEnabled: true,
      config: true,
    },
  });

  return integrations.filter((integration) => {
    const isAvailableToBench = integration.userId === DEV_USER_ID || integration.poolingEnabled;
    return isAvailableToBench && hasEncryptedCredentials(integration.config);
  }).length;
}

async function syncComputeTokensWithRetries(): Promise<void> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= COMPUTE_TOKEN_SYNC_ATTEMPTS; attempt++) {
    try {
      const count = await syncIntegrations();
      const usableClaudeCodeCount = await countUsableClaudeCodeIntegrations();
      if (usableClaudeCodeCount === 0) {
        if (process.env.SEED_ALLOW_MISSING_CLAUDE_CODE === '1') {
          if (!process.env.ANTHROPIC_API_KEY?.trim()) {
            throw new Error(
              'SEED_ALLOW_MISSING_CLAUDE_CODE=1 requires a non-empty ANTHROPIC_API_KEY'
            );
          }
          console.warn(
            `  ⚠️  Compute Tokens (integrations): ${count} synced, ` +
              '0 usable claude_code — proceeding with the caller-validated ' +
              'ANTHROPIC_API_KEY fallback (SEED_ALLOW_MISSING_CLAUDE_CODE=1)'
          );
        } else {
          throw new Error('No usable claude_code integrations after sync');
        }
      }
      const { usable: usableGptCodeCount, rateLimited: rateLimitedGptCodeCount } =
        await inspectGptCodeIntegrations();
      if (usableGptCodeCount === 0) {
        // A gpt_code (Codex) integration that EXISTS but is merely rate-limited
        // is an external-quota transient (e.g. the ChatGPT quota window), not a
        // misconfiguration. It must never hard-fail the compute-token sync: the
        // claude tokens every non-Codex run needs still synced, and a run that
        // actually uses Codex will surface the quota error at runtime. Only a
        // genuinely MISSING integration is a real setup problem — and even that
        // stays skippable via the explicit opt-out for known Codex-free runs.
        if (rateLimitedGptCodeCount > 0) {
          console.warn(
            `  ⚠️  Compute Tokens (integrations): ${count} synced, 0 usable gpt_code ` +
              `(${rateLimitedGptCodeCount} present but rate-limited by an external quota) — ` +
              `proceeding; claude tokens synced`
          );
          return;
        }
        // gpt_code (Codex) is only needed by runs that actually spawn a Codex
        // agent. When a caller knows the run doesn't use Codex — e.g. the
        // AgentCard browser payment-lifecycle gate — a missing Codex integration
        // must not block an otherwise-healthy compute-token sync.
        // Default (flag unset) stays strict so Codex regressions still surface.
        if (process.env.SEED_ALLOW_MISSING_GPT_CODE === '1') {
          console.warn(
            `  ⚠️  Compute Tokens (integrations): ${count} synced, ` +
              `${usableClaudeCodeCount} usable claude_code, 0 usable gpt_code — ` +
              `proceeding without Codex (SEED_ALLOW_MISSING_GPT_CODE=1; this run does not use Codex)`
          );
          return;
        }
        throw new Error('No usable gpt_code integrations after sync');
      }
      console.log(
        `  ✅ Compute Tokens (integrations): ${count} synced, ` +
          `${usableClaudeCodeCount} usable claude_code, ${usableGptCodeCount} usable gpt_code`
      );
      return;
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `  ❌ Compute Tokens (integrations): attempt ${attempt}/${COMPUTE_TOKEN_SYNC_ATTEMPTS} failed: ${message}`
      );
      if (attempt < COMPUTE_TOKEN_SYNC_ATTEMPTS) {
        await sleep(500 * 2 ** (attempt - 1));
      }
    }
  }

  throw new Error(
    `Compute token sync failed after ${COMPUTE_TOKEN_SYNC_ATTEMPTS} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

async function syncBrowserCredentials(failures?: Error[]): Promise<void> {
  // ── Browser Passwords ──
  await syncRequiredTable(
    'Browser Passwords',
    async () => {
      const passwords = await scopedRemoteBrowserAuth.browserPassword();
      return syncBrowserPasswordCredentials(local.browserPassword, passwords);
    },
    failures
  );

  await syncPasskeysOnly(failures);
}

async function syncPasskeysOnly(
  failures?: Error[],
  options: { authoritative?: boolean } = {}
): Promise<void> {
  // ── Passkey Credentials ──
  await syncRequiredTable(
    'Passkey Credentials',
    async () => {
      const passkeys = await scopedRemoteBrowserAuth.passkeyCredential();
      return syncPasskeyCredentialRows(local.passkeyCredential, passkeys);
    },
    failures
  );

  if (options.authoritative) {
    await syncRequiredTable(
      'Stale Local Passkeys',
      async () => {
        const remoteKeys = await remote.passkeyCredential.findMany({
          where: passkeySyncWhere(DEV_USER_ID, SEED_COOKIE_DOMAINS),
          select: { rpId: true, credentialId: true },
        });
        const liveKeys = new Set(
          remoteKeys.map(({ rpId, credentialId }) => `${rpId}\u0000${credentialId}`)
        );
        const localKeys = await local.passkeyCredential.findMany({
          where: passkeySyncWhere(DEV_USER_ID, SEED_COOKIE_DOMAINS),
          select: { id: true, rpId: true, credentialId: true },
        });
        const staleIds = localKeys
          .filter(({ rpId, credentialId }) => !liveKeys.has(`${rpId}\u0000${credentialId}`))
          .map(({ id }) => id);
        if (staleIds.length === 0) return 0;
        const deleted = await local.passkeyCredential.deleteMany({
          where: { id: { in: staleIds } },
        });
        return deleted.count;
      },
      failures
    );
  }
}

async function syncBrowserAuthForCurrentMode(failures?: Error[]): Promise<void> {
  if (SKIP_BROWSER_AUTH_SYNC) {
    console.log('  ⏭️  Browser auth state: skipped for simulated benchmark setup');
    return;
  }

  await syncBrowserState(failures);
  await syncBrowserCredentials(failures);
}

// Benchmark live fixtures shell out to `--credentials-only` while the isolated
// bench stack is under load (concurrent agents, cascade deletes of finished
// agent trees). A single transient local-DB failure (pool timeout, connection
// churn, upsert race) would otherwise fail the whole benchmark task before an
// agent even exists — observed 2026-07-18 (claude-code-agent smoke: one
// `localCookie.upsert()` invocation failed; the identical sync succeeded
// seconds later). Every sync step is an idempotent upsert, so bounded retries
// are safe. Mirrors syncComputeTokensWithRetries above.
const BROWSER_AUTH_SYNC_ATTEMPTS = 3;

async function syncBrowserAuthWithRetries(): Promise<void> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= BROWSER_AUTH_SYNC_ATTEMPTS; attempt++) {
    try {
      await syncBrowserAuthForCurrentMode();
      return;
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `  ❌ Browser auth sync: attempt ${attempt}/${BROWSER_AUTH_SYNC_ATTEMPTS} failed: ${message}`
      );
      if (attempt < BROWSER_AUTH_SYNC_ATTEMPTS) {
        await sleep(500 * 2 ** (attempt - 1));
      }
    }
  }

  throw new Error(
    `Browser auth sync failed after ${BROWSER_AUTH_SYNC_ATTEMPTS} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

function throwBrowserAuthSyncFailures(failures: Error[]): void {
  if (failures.length === 0) return;
  if (failures.length === 1) throw failures[0];
  throw new Error(
    `Browser auth sync failed for ${failures.length} tables: ${failures
      .map((failure) => failure.message)
      .join('; ')}`
  );
}

async function sync() {
  console.log('🔄 Syncing from production database...');
  console.log(`   Remote: ${REMOTE_URL.replace(/:[^:@]+@/, ':***@')}`);
  console.log(`   Local:  ${process.env.DATABASE_URL?.replace(/:[^:@]+@/, ':***@') ?? 'default'}`);
  console.log(`   User:   ${DEV_USER_ID}\n`);

  // Verify remote connectivity
  await remote.$queryRaw`SELECT 1`;

  if (COMPUTE_TOKENS_ONLY) {
    await syncComputeTokensWithRetries();
    console.log('\n🔄 Compute token sync complete.');
    return;
  }

  if (PASSKEYS_ONLY) {
    console.log(
      '  ℹ️  Syncing authoritative passkeys only; browser state and passwords are excluded'
    );
    await syncPasskeysOnly(undefined, { authoritative: true });
    console.log('\n🔄 Passkey sync complete.');
    return;
  }

  if (CREDENTIALS_ONLY) {
    console.log(
      SEED_COOKIE_DOMAINS.length > 0
        ? `  ℹ️  Refreshing production browser auth for ${SEED_COOKIE_DOMAINS.join(', ')} while preserving local-only rows`
        : '  ℹ️  Refreshing the complete production browser-auth graph while preserving local-only rows'
    );
    await syncBrowserAuthWithRetries();
    console.log('\n🔄 Credential sync complete.');
    return;
  }

  // ── Global: Tools ──
  await syncTable('Tools', async () => {
    const tools = await remote.tool.findMany();
    for (const t of tools) {
      await local.tool.upsert({
        where: { name: t.name },
        create: { id: t.id, name: t.name, description: t.description, createdAt: t.createdAt },
        update: { description: t.description },
      });
    }
    return tools.length;
  });

  // ── User ──
  await syncTable('User', async () => {
    const count = await syncUserRecord(remote.user, local.user, DEV_USER_ID);
    if (count === 0) throw new Error(`User ${DEV_USER_ID} not found in remote`);
    return count;
  });

  // ── Credits ──
  await syncTable('Credits', async () => {
    const credits = await remote.credit.findMany({ where: { userId: DEV_USER_ID } });
    return upsertById(local.credit, credits);
  });

  // ── Subscription ──
  await syncTable('Subscription', async () => {
    const sub = await remote.subscription.findUnique({ where: { userId: DEV_USER_ID } });
    if (!sub) return 0;
    const { id, ...rest } = sub;
    await local.subscription.upsert({
      where: { userId: DEV_USER_ID },
      create: sub as any,
      update: rest as any,
    });
    return 1;
  });

  // ── Integrations ──
  await syncTable('Integrations', syncIntegrations);

  // ── Email Integration Credentials ──
  await syncTable('Email Credentials', async () => {
    const creds = await remote.emailIntegrationCredential.findMany({
      where: { userId: DEV_USER_ID },
    });
    return upsertById(local.emailIntegrationCredential, creds);
  });

  // ── People (contacts) ──
  await syncTable('People', async () => {
    const people = await remote.person.findMany({ where: { userId: DEV_USER_ID } });
    return upsertById(local.person, people);
  });

  // ── Message Records ──
  await syncTable('Message Records', async () => {
    const personIds = (
      await remote.person.findMany({
        where: { userId: DEV_USER_ID },
        select: { id: true },
      })
    ).map((p) => p.id);
    if (personIds.length === 0) return 0;

    // Cap at the latest 10k messages across all contacts to keep seed fast and
    // local DB lean; older history isn't needed for dev/testing.
    const MESSAGE_LIMIT = 10_000;
    const messages = await remote.messageRecord.findMany({
      where: { personId: { in: personIds } },
      orderBy: { timestamp: 'desc' },
      take: MESSAGE_LIMIT,
    });

    // The local benchmark DB runs beside the entire agent stack. Launching 500
    // Prisma upserts at once repeatedly killed Postgres on 4GB Fly primaries,
    // leaving every seed retry to fail with P1001. Stay below the configured
    // 50-connection pool so cold pool replacements can seed without an infra
    // loss; normal benchmark claims restore the resulting persistent dump.
    return syncRowsWithConcurrency(
      messages,
      25,
      (m) => {
        const { id, ...rest } = m;
        return local.messageRecord.upsert({
          where: { id },
          create: m as any,
          update: rest as any,
        });
      },
      (completed, total) => {
        if (total > 25 && completed < total) {
          process.stdout.write(`     ${completed}/${total}...\r`);
        }
      }
    );
  });

  // ── Rose API Keys ──
  await syncTable('Rose API Keys', async () => {
    const keys = await remote.roseApiKey.findMany({ where: { userId: DEV_USER_ID } });
    return upsertById(local.roseApiKey, keys);
  });

  // ── Complete browser auth graph + credentials ──
  const browserAuthSyncFailures: Error[] = [];
  await syncBrowserAuthForCurrentMode(browserAuthSyncFailures);

  // ── Goal Blueprints ──
  await syncTable('Goal Blueprints', async () => {
    const blueprints = await remote.goalBlueprint.findMany({ where: { userId: DEV_USER_ID } });
    return upsertById(local.goalBlueprint, blueprints);
  });

  // ── GitHub Repo Access ──
  await syncTable('GitHub Repos', async () => {
    const repos = await remote.githubRepoAccess.findMany({ where: { userId: DEV_USER_ID } });
    return upsertById(local.githubRepoAccess, repos);
  });

  // ── SMS Session ──
  await syncTable('SMS Session', async () => {
    const session = await remote.smsSession.findUnique({ where: { userId: DEV_USER_ID } });
    if (!session) return 0;
    const { id, ...rest } = session;
    await local.smsSession.upsert({
      where: { userId: DEV_USER_ID },
      create: session as any,
      update: rest as any,
    });
    return 1;
  });

  // ── Feedback ──
  await syncTable('Feedback', async () => {
    const feedback = await remote.feedback.findMany({ where: { userId: DEV_USER_ID } });
    return upsertById(local.feedback, feedback);
  });

  // ── Waitlist (global, phone-bearing only) ──
  // Not user-scoped: these are the actionable signups the admin-health
  // "Waitlist People" panel lists + texts off the waitlist. Legacy email-only
  // rows are skipped (the panel filters them out anyway), so the local copy
  // stays tiny. The invite SMS only fires in production, so seeding real
  // numbers here is safe for local dev.
  await syncTable('Waitlist', async () => {
    // Explicit select (omits invitedAt): prod may not have that column yet the
    // first time this ships, and local invitedAt should start null anyway.
    const rawRows = await remote.waitlist.findMany({
      where: { phone: { not: null } },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        variant: true,
        referralCode: true,
        createdAt: true,
      },
    });
    // Drop empty-string phones: they can't be texted and would reach the admin
    // invite flow with a blank SMS destination.
    const rows = rawRows.filter((r) => (r.phone ?? '').trim() !== '');
    const synced = await upsertById(local.waitlist, rows);

    // Also pull the accounts these phones belong to, so the "Waitlist People"
    // panel renders truthful account/gate status locally instead of "No account
    // yet" for everyone. Minimal projection only — never copy sensitive columns
    // (e.g. encryptedPaymentInformation) or offWaitlistAt (may be absent in prod).
    const phones = rows.map((r) => r.phone).filter((p): p is string => p !== null);
    if (phones.length > 0) {
      const accounts = await remote.user.findMany({
        where: { phone: { in: phones } },
        select: { id: true, userId: true, phone: true, usedInviteCode: true },
      });
      await upsertById(local.user, accounts);
    }
    return synced;
  });

  throwBrowserAuthSyncFailures(browserAuthSyncFailures);

  console.log('\n🔄 Sync complete.');
}

sync()
  .catch((err) => {
    console.error('❌ Sync failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await remote.$disconnect();
    await local.$disconnect();
  });
