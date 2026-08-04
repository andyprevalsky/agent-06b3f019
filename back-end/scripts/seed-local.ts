/**
 * Sync user data from the remote (production) Supabase database to the local Postgres.
 *
 * Reads the remote DATABASE_URL from back-end/.env (since run.sh overrides
 * process.env.DATABASE_URL to point to local). Syncs all user-scoped data for
 * the dev user without overwriting locally-spawned agents.
 *
 * Usage: DATABASE_URL=<local_url> npx tsx scripts/seed-local.ts
 */

import { writeFileSync } from 'node:fs';

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
import { streamJsonbOrigins, type JsonbOriginTable } from './seed-jsonb-stream';
import {
  SEED_PEAK_RSS_BUDGET_MB,
  SEED_RSS_REPORT_ENV,
  withinSeedBudget,
  type SeedRssReport,
} from '../src/providers/seedMemoryBudget';

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
// SEED_REMOTE_DATABASE_URL overrides the source database.
//
// The seed normally reads prod via .env, which makes any measurement of its
// footprint depend on outbound reachability: on 2026-07-29 every host in .env
// was TCP-closed locally and 10 consecutive runs died in ~4s, producing a
// "122MB peak" that was really the cost of failing. Pointing the source at a
// local restore of the same prod dump exercises the identical code path and row
// counts with no network in the loop. Never set in prod.
const REMOTE_URL = COMPUTE_TOKENS_ONLY
  ? COMPUTE_TOKEN_SOURCE_DATABASE_URL
  : process.env.SEED_REMOTE_DATABASE_URL || selectRemoteDatabaseUrl(envVars);
const LOCAL_URL = process.env.DATABASE_URL;

if (!REMOTE_URL) {
  console.error('❌ No remote DATABASE_URL found in .env');
  process.exit(1);
}
if (!LOCAL_URL) {
  console.error('❌ No local DATABASE_URL found in the environment');
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

// SEED_COOKIE_DOMAINS scopes every domain-bearing browser-auth table to the
// domains a benchmark task needs. Set by run_benchmark from the task's
// environment.live_cookie_domains. Empty → full browser-auth graph. Filter
// logic lives in cookie-domain-scope.ts and is pinned by blackbox coverage.
const SEED_COOKIE_DOMAINS = parseCookieDomains(process.env.SEED_COOKIE_DOMAINS);

function positivePageSize(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got ${process.env[name]}`);
  }
  return value;
}

const COOKIE_PAGE_SIZE = positivePageSize('SEED_COOKIE_PAGE_SIZE', 25);
const PERSON_PAGE_SIZE = positivePageSize('SEED_PERSON_PAGE_SIZE', 50);
const MESSAGE_PAGE_SIZE = positivePageSize('SEED_MESSAGE_PAGE_SIZE', 50);
const CREDENTIAL_PAGE_SIZE = positivePageSize('SEED_CREDENTIAL_PAGE_SIZE', 50);

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

async function syncJsonbOriginTable(table: JsonbOriginTable): Promise<number> {
  return streamJsonbOrigins({
    remoteUrl: REMOTE_URL!,
    localUrl: LOCAL_URL!,
    userId: DEV_USER_ID,
    domains: SEED_COOKIE_DOMAINS,
    table,
  });
}

/**
 * Peak RSS seen so far, and the worst table. Sampled around every sync step so
 * a regression names the table that caused it instead of just the total.
 *
 * The seed shares a 4GB fleet primary with Postgres, Temporal, the backend and
 * a 12-process worker pool. It was SIGKILLed there on 2026-07-29 and the box
 * was dropped from the fleet as an infra loss, with nothing recording why.
 * Enforced by src/tests/unit/seed-memory-ratchet.test.ts.
 */
const rssPeaks: Array<{ name: string; peakRssMb: number }> = [];
let peakRssMb = 0;

function sampleRss(name: string): void {
  const mb = Math.round(process.memoryUsage().rss / (1024 * 1024));
  if (mb > peakRssMb) peakRssMb = mb;
  const existing = rssPeaks.find((entry) => entry.name === name);
  if (existing === undefined) rssPeaks.push({ name, peakRssMb: mb });
  else if (mb > existing.peakRssMb) existing.peakRssMb = mb;
}

export function seedRssReport(): SeedRssReport {
  return {
    peakRssMb,
    budgetMb: SEED_PEAK_RSS_BUDGET_MB,
    tables: [...rssPeaks].sort((a, b) => b.peakRssMb - a.peakRssMb),
  };
}

function writeRssReport(): void {
  const target = process.env[SEED_RSS_REPORT_ENV];
  const report = seedRssReport();
  const worst = report.tables[0];
  console.log(
    `  🧠 seed peak RSS: ${report.peakRssMb}MB / budget ${report.budgetMb}MB` +
      (worst ? ` (worst: ${worst.name} @ ${worst.peakRssMb}MB)` : '')
  );
  if (target !== undefined && target !== '') {
    try {
      writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
    } catch (err) {
      console.warn(
        `  ⚠️ could not write seed RSS report: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  if (!withinSeedBudget(report.peakRssMb)) {
    // Loud, but NOT fatal: a seed that succeeded should not be turned into an
    // infra loss by its own instrumentation. The ratchet test is the gate.
    console.warn(
      `  ⚠️ seed peak RSS ${report.peakRssMb}MB exceeds the ${report.budgetMb}MB ratchet — ` +
        'make the seed leaner rather than raising the budget (see providers/seedMemoryBudget.ts)'
    );
  }
}

async function syncTable(name: string, fn: () => Promise<number>): Promise<void> {
  sampleRss(name);
  await runSyncStep(name, fn);
  sampleRss(name);
}

async function syncRequiredTable(
  name: string,
  fn: () => Promise<number>,
  failures?: Error[]
): Promise<void> {
  sampleRss(name);
  try {
    const count = await syncRequiredCredentialTable(name, fn);
    sampleRss(name);
    console.log(`  ✅ ${name}: ${count} synced`);
  } catch (err) {
    sampleRss(name);
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
      // Fresh local table (the benchmark cold path): one bulk createMany instead of
      // ~N per-row upsert round-trips (the ~780s bottleneck). On an already-populated
      // table (warm restore / re-sync) fall back to upsert so refreshed cookie values
      // overwrite stale rows. skipDuplicates makes the bulk path idempotent against
      // the natural-key unique constraint. The remote side is always paged: a
      // 22k-cookie account previously retained the whole result array and added
      // ~340MB to the seed's cold peak.
      const existingLocal = await local.cookie.count({ where: { userId: DEV_USER_ID } });
      let synced = 0;
      synced = await syncPagedCredentials(
        (page) => scopedRemoteBrowserAuth.cookie(page),
        async (cookies) => {
          if (existingLocal === 0) {
            await local.cookie.createMany({
              data: cookies as never,
              skipDuplicates: true,
            });
          } else {
            await syncCookieCredentials(local.cookie, cookies);
          }
          return cookies.length;
        },
        COOKIE_PAGE_SIZE
      );
      if (SEED_COOKIE_DOMAINS.length > 0) {
        process.stdout.write(
          `     scoped to ${SEED_COOKIE_DOMAINS.length} domain(s) [${SEED_COOKIE_DOMAINS.join(
            ', '
          )}] → ${synced} cookies\n`
        );
      } else if (synced > COOKIE_PAGE_SIZE) {
        process.stdout.write(`     ${synced} cookies copied in bounded pages\n`);
      }
      return synced;
    },
    failures
  );

  // ── Durable browser-auth references ──
  await syncRequiredTable(
    'Cookie Bundles',
    async () =>
      syncPagedCredentials(
        (page) => scopedRemoteBrowserAuth.cookieBundle(page),
        (bundles) => syncCookieBundleCredentials(local.cookieBundle, bundles),
        CREDENTIAL_PAGE_SIZE
      ),
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
  // Streamed directly between Postgres processes. Row-count paging is not a
  // memory bound for JSONB: a single canonical JSON string can still exceed
  // the seed's entire budget before Prisma parses it.
  await syncRequiredTable(
    'LocalStorage',
    () => syncJsonbOriginTable('LocalStorageOrigin'),
    failures
  );

  // ── IndexedDB Origins ──
  // The current prod dump's largest compressed row is only 13MB, but Prisma's
  // nested-object materialization grew RSS by >3.8GB. Casting it to text still
  // cost ~450MB. COPY streaming keeps both forms out of the Node heap.
  await syncRequiredTable('IndexedDB', () => syncJsonbOriginTable('IndexedDBOrigin'), failures);

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
    () => syncJsonbOriginTable('CacheStorageOrigin'),
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
    async () =>
      syncPagedCredentials(
        (page) => scopedRemoteBrowserAuth.browserPassword(page),
        (passwords) => syncBrowserPasswordCredentials(local.browserPassword, passwords),
        CREDENTIAL_PAGE_SIZE
      ),
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
    // Paged for the same reason as Message Records: bound peak heap by page
    // size, not by contact count. A 2k-contact user is normal here.
    let peopleSynced = 0;
    for (let skip = 0; ; skip += PERSON_PAGE_SIZE) {
      const page = await remote.person.findMany({
        where: { userId: DEV_USER_ID },
        orderBy: { id: 'asc' },
        skip,
        take: PERSON_PAGE_SIZE,
      });
      if (page.length === 0) break;
      peopleSynced += await upsertById(local.person, page);
      sampleRss('People');
      if (page.length < PERSON_PAGE_SIZE) break;
    }
    return peopleSynced;
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
    //
    // PAGED, not materialised. `findMany({ take: 10_000 })` held every row AND
    // its message body in one array before the first write; on a 4GB fleet
    // primary shared with Postgres + a 12-process worker pool that was the
    // SIGKILL (rc=137) which dropped a box from the 2026-07-29 fleet run before
    // its start barrier. Peak heap is now bounded by PAGE x row size, not by the
    // whole table. Enforced by src/tests/unit/seed-memory-ratchet.test.ts.
    const MESSAGE_LIMIT = 10_000;
    let messagesSynced = 0;
    for (let skip = 0; skip < MESSAGE_LIMIT; skip += MESSAGE_PAGE_SIZE) {
      const page = await remote.messageRecord.findMany({
        where: { personId: { in: personIds } },
        orderBy: { timestamp: 'desc' },
        skip,
        take: Math.min(MESSAGE_PAGE_SIZE, MESSAGE_LIMIT - skip),
      });
      if (page.length === 0) break;
      // The local benchmark DB runs beside the entire agent stack. Launching 500
      // Prisma upserts at once repeatedly killed Postgres on 4GB Fly primaries,
      // leaving every seed retry to fail with P1001. Stay below the configured
      // 50-connection pool.
      messagesSynced += await syncRowsWithConcurrency(
        page,
        25,
        (m) => {
          const { id, ...rest } = m;
          return local.messageRecord.upsert({
            where: { id },
            create: m as any,
            update: rest as any,
          });
        },
        (completed) => {
          const done = messagesSynced + completed;
          if (done < MESSAGE_LIMIT) process.stdout.write(`     ${done}/${MESSAGE_LIMIT}...\r`);
        }
      );
      sampleRss('Message Records');
      if (page.length < MESSAGE_PAGE_SIZE) break;
    }
    return messagesSynced;
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
    // Report BEFORE disconnecting: the peak is what matters and the per-table
    // attribution is the whole point of the instrument. Defined but never
    // called on 2026-07-29, which is why the first real measurement (4983MB)
    // could not say which table produced it.
    writeRssReport();
    await remote.$disconnect();
    await local.$disconnect();
  });
