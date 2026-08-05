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
  syncPagedCredentials,
  syncPasskeyCredentialRows,
  syncRequiredCredentialTable,
  syncSteelSessionAuthCredentials,
} from './seed-local-credentials';
import {
  runSyncStep,
  syncRowsWithConcurrency,
  syncUserRecord,
  syncWaitlistAccounts,
} from './seed-local-helpers';
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
const COMPUTE_TOKEN_REQUIRED_TYPES = parseComputeTokenRequiredTypes(
  process.env.SEED_REQUIRE_COMPUTE_TOKEN_TYPES
);
const POOL_DEV_COMPUTE_TOKENS_FOR_SYNTHETIC_USERS =
  process.env.SEED_POOL_DEV_COMPUTE_TOKENS_FOR_SYNTHETIC_USERS === '1';
const ISOLATED_BENCHMARK_RUN = process.env.BENCHMARK_ISOLATED_RUN === 'true';

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
/**
 * Deterministic ordering is what makes `skip`/`take` paging safe — without it
 * Postgres may return overlapping or missing rows across pages.
 */
function pagedArgs(where: unknown, page?: { skip: number; take: number }) {
  return page
    ? { where: where as never, skip: page.skip, take: page.take, orderBy: { id: 'asc' as const } }
    : { where: where as never };
}

const scopedRemoteBrowserAuth = createScopedBrowserAuthReaders(
  {
    cookie: (where, page) => remote.cookie.findMany(pagedArgs(where, page)),
    cookieBundle: (where, page) => remote.cookieBundle.findMany(pagedArgs(where, page)),
    steelSessionAuth: (where, page) => remote.steelSessionAuth.findMany(pagedArgs(where, page)),
    localStorageOrigin: (where, page) => remote.localStorageOrigin.findMany(pagedArgs(where, page)),
    indexedDBOrigin: (where, page) => remote.indexedDBOrigin.findMany(pagedArgs(where, page)),
    browserPermission: (where, page) => remote.browserPermission.findMany(pagedArgs(where, page)),
    cacheStorageOrigin: (where, page) => remote.cacheStorageOrigin.findMany(pagedArgs(where, page)),
    browserPassword: (where, page) => remote.browserPassword.findMany(pagedArgs(where, page)),
    passkeyCredential: (where, page) => remote.passkeyCredential.findMany(pagedArgs(where, page)),
  },
  DEV_USER_ID,
  SEED_COOKIE_DOMAINS
);

/**
 * Page sizes are per-table because the blobs are not uniform. Peak heap is
 * driven by (page size x row size), so the right page is the one that keeps
 * that product bounded — a row count alone is not a memory bound.
 *
 * LocalStorageOrigin.entries averages ~23KB over ~3.7k prod rows, so a 100-row
 * page is a couple of MB. IndexedDBOrigin.databases averages ~2.5MB over only
 * 16 rows and its largest single row is 38MB uncompressed, so the same 100-row
 * page would read the entire table and reproduce the original OOM.
 */
const ORIGIN_SYNC_PAGE_SIZE = Number(process.env.SEED_ORIGIN_PAGE_SIZE ?? 100);
// Measured: with a 400MB heap the 38MB row still OOMs at page size 1, and it
// succeeds at 900MB — so ~0.5-0.9GB is the irreducible cost of parsing that one
// row. Peak is therefore bounded by the LARGEST SINGLE ROW, which is the best
// achievable without streaming the blob itself, and fits any bench guest.
const BLOB_ORIGIN_SYNC_PAGE_SIZE = Number(process.env.SEED_BLOB_ORIGIN_PAGE_SIZE ?? 1);

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

/**
 * Upsert prod rows into the local database keyed on primary id.
 *
 * A model can carry a compound unique key in addition to `id` (for example
 * `EmailIntegrationCredential` is unique on `(userId, provider, email)`). When a
 * stale local row holds the same tuple under a DIFFERENT primary key, the
 * id-keyed upsert falls through to `create` and dies on P2002, which aborts the
 * entire seed and blocks every deploy from that worktree. Reconcile by updating
 * the row that already owns the tuple, preserving its local id so dependent rows
 * survive — the same treatment `syncIntegrationCredentials` gives `Integration`.
 */
async function upsertById(model: any, records: any[]): Promise<number> {
  for (const r of records) {
    const { id, ...rest } = r;
    try {
      await model.upsert({ where: { id }, create: r, update: rest });
    } catch (error) {
      const target =
        (error as { code?: string; meta?: { target?: unknown } })?.code === 'P2002'
          ? (error as { meta?: { target?: unknown } }).meta?.target
          : undefined;
      if (!Array.isArray(target) || target.length === 0 || target.includes('id')) throw error;
      // Only the CREATE branch is safe to recover. If `id` already exists then
      // the update moved that row onto a compound key owned by a different
      // local row; rewriting the other row would silently leave the row we were
      // actually asked to sync stale, so surface it instead.
      const existingById = await model.findUnique({ where: { id }, select: { id: true } });
      if (existingById) throw error;

      const fields = target as string[];
      const compoundKey = fields.join('_');
      const compoundValue = Object.fromEntries(fields.map((field) => [field, r[field]]));
      // Refresh the conflicting row in place; its local id stays authoritative.
      await model.update({ where: { [compoundKey]: compoundValue }, data: rest });
    }
  }
  return records.length;
}

// Columns this sync reads FROM PRODUCTION. An unqualified findMany() selects
// every column in the LOCAL schema, so the moment a migration adds a column that
// prod has not deployed yet, the cold-sync dies with P2022 and every isolated
// benchmark stack fails to boot. Local-policy columns (poolingEnabledOverride)
// are deliberately absent: they are decided locally, never sourced from prod.
const PROD_INTEGRATION_COLUMNS = {
  id: true,
  userId: true,
  type: true,
  name: true,
  status: true,
  isActive: true,
  lastSyncAt: true,
  lastSuccessfulSyncAt: true,
  lastFailedSyncAt: true,
  failureReason: true,
  config: true,
  poolingEnabled: true,
  rateLimitedUntil: true,
  lastUsedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

async function syncIntegrations(): Promise<number> {
  // Sync dev user's integrations + all pool tokens (needed for Claude Code benchmarks)
  const userIntegrations = await remote.integration.findMany({
    where: { userId: DEV_USER_ID },
    select: PROD_INTEGRATION_COLUMNS,
  });
  const poolIntegrations = await remote.integration.findMany({
    where: { poolingEnabled: true, userId: { not: DEV_USER_ID } },
    select: PROD_INTEGRATION_COLUMNS,
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

/**
 * Synthetic benchmark users must not receive copies of the developer's credential rows. For
 * isolated benchmark databases only, this explicit opt-in exposes the already-synced dev-owned
 * provider through the normal compute pool instead. Ownership and encrypted configuration stay
 * on the original Integration row; only its local pool eligibility changes.
 */
async function poolRequiredDevComputeTokensForSyntheticUsers(): Promise<number> {
  if (!POOL_DEV_COMPUTE_TOKENS_FOR_SYNTHETIC_USERS) return 0;
  if (!ISOLATED_BENCHMARK_RUN) {
    console.warn(
      '  ⚠️  Compute Tokens (integrations): refusing synthetic-user pool eligibility ' +
        'outside an explicitly isolated benchmark database'
    );
    return 0;
  }

  const requiredNames = [...COMPUTE_TOKEN_REQUIRED_TYPES].map((type) =>
    type === 'claude' ? 'claude_code' : 'gpt_code'
  );
  const result = await local.integration.updateMany({
    where: {
      userId: DEV_USER_ID,
      name: { in: requiredNames },
      status: 'CONNECTED',
    },
    data: { poolingEnabled: true },
  });
  console.log(
    `  🧪 Compute Tokens (integrations): ${result.count} dev-owned row(s) made pool-eligible ` +
      'inside the isolated synthetic-user benchmark database'
  );
  return result.count;
}

// Browser auth sync shared by full sync and --credentials-only. Natural-keyed
// credentials merge production rows; provider-profile mappings are replaced so
// their BrowserContext foreign key always points at the local context row.
async function syncBrowserState(failures?: Error[]): Promise<void> {
  // ── Browser Context ──
  await syncRequiredTable(
    'Browser Context',
    async () => {
      // Select the stable cross-version columns explicitly. During a pre-deploy
      // benchmark the generated client can include a new local-only column that
      // production has not migrated yet; an implicit SELECT * would make the
      // auth-state sync fail before the migration can be exercised locally.
      const ctx = await remote.browserContext.findUnique({
        where: { userId: DEV_USER_ID },
        select: {
          id: true,
          userId: true,
          contextId: true,
          createdAt: true,
          updatedAt: true,
        },
      });
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
  // Paged: `entries` holds the encrypted localStorage payload (84MB across
  // ~3.7k rows in prod today) and parsing it all at once is what exhausted the
  // heap on every bench guest.
  await syncRequiredTable(
    'LocalStorage',
    async () =>
      syncPagedCredentials(
        (page) => scopedRemoteBrowserAuth.localStorageOrigin(page),
        (origins) => syncOriginCredentials(local.localStorageOrigin, origins),
        ORIGIN_SYNC_PAGE_SIZE
      ),
    failures
  );

  // ── IndexedDB Origins ──
  // Paged: few rows, but `databases` is the single largest blob in the seed
  // (one prod row is 38MB uncompressed).
  await syncRequiredTable(
    'IndexedDB',
    async () =>
      syncPagedCredentials(
        (page) => scopedRemoteBrowserAuth.indexedDBOrigin(page),
        (origins) => syncOriginCredentials(local.indexedDBOrigin, origins),
        BLOB_ORIGIN_SYNC_PAGE_SIZE
      ),
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
    async () =>
      syncPagedCredentials(
        (page) => scopedRemoteBrowserAuth.cacheStorageOrigin(page),
        (caches) => syncOriginCredentials(local.cacheStorageOrigin, caches),
        ORIGIN_SYNC_PAGE_SIZE
      ),
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

function parseComputeTokenRequiredTypes(raw: string | undefined): Set<'claude' | 'gpt'> {
  const value = raw?.trim() || 'claude,gpt';
  const types = new Set<'claude' | 'gpt'>();
  for (const part of value.split(',')) {
    const token = part.trim().toLowerCase();
    if (token === '') continue;
    if (token !== 'claude' && token !== 'gpt') {
      throw new Error(
        `SEED_REQUIRE_COMPUTE_TOKEN_TYPES must contain only claude,gpt; received ${JSON.stringify(
          raw
        )}`
      );
    }
    types.add(token);
  }
  if (types.size === 0) {
    throw new Error(
      'SEED_REQUIRE_COMPUTE_TOKEN_TYPES must require at least one compute token type'
    );
  }
  return types;
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
      await poolRequiredDevComputeTokensForSyntheticUsers();
      const usableClaudeCodeCount = await countUsableClaudeCodeIntegrations();
      if (usableClaudeCodeCount === 0) {
        if (!COMPUTE_TOKEN_REQUIRED_TYPES.has('claude')) {
          console.warn(
            `  ⚠️  Compute Tokens (integrations): ${count} synced, ` +
              '0 usable claude_code — proceeding because this run requires GPT compute only ' +
              '(SEED_REQUIRE_COMPUTE_TOKEN_TYPES=gpt)'
          );
        } else if (process.env.SEED_ALLOW_MISSING_CLAUDE_CODE_FOR_NON_CLAUDE_TASK === '1') {
          console.warn(
            `  ⚠️  Compute Tokens (integrations): ${count} synced, 0 usable claude_code — ` +
              `proceeding without Claude Code for a launcher-scoped non-Claude task ` +
              `(SEED_ALLOW_MISSING_CLAUDE_CODE_FOR_NON_CLAUDE_TASK=1)`
          );
        } else if (process.env.SEED_ALLOW_MISSING_CLAUDE_CODE === '1') {
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
        if (!COMPUTE_TOKEN_REQUIRED_TYPES.has('gpt')) {
          console.warn(
            `  ⚠️  Compute Tokens (integrations): ${count} synced, ` +
              `${usableClaudeCodeCount} usable claude_code, 0 usable gpt_code — ` +
              'proceeding because this run requires Claude compute only ' +
              '(SEED_REQUIRE_COMPUTE_TOKEN_TYPES=claude)'
          );
          return;
        }
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
      await syncWaitlistAccounts(remote.user, local.user, phones);
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
