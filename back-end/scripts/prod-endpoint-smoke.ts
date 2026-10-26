#!/usr/bin/env tsx
/**
 * Light multi-domain endpoint smoke for a running backend (defaults to prod).
 *
 * Why this exists: the deploy post-check historically probed a SINGLE DB-backed
 * endpoint (`GET /api/agents`, the Agent domain). A `200` there proves the
 * Agent/Prisma path is healthy but says nothing about other domains. On
 * 2026-07-06 the compute-token domain 500'd on every request because the
 * `ComputeTokenLineageLease` / `ComputeTokenFastCacheAffinity` tables were never
 * migrated into prod (schema.prisma + code shipped, migration did not) — and the
 * single-endpoint probe never touched that route, so every agent silently fell
 * through to the paid OpenRouter waterfall while `/api/agents` stayed green.
 *
 * This probe hits one representative DB-backed endpoint per domain and fails on
 * any 5xx (or network error). Non-5xx (200/400/401/404) counts as "the route is
 * alive and did not crash" — we are catching server crashes and schema/migration
 * drift, not asserting business results.
 *
 * Runs read-only GETs, one deliberately unauthenticated no-op POST, OPTIONS
 * preflights, and a READ ONLY catalog check (scripts/verify-schema-objects.ts)
 * that every migration-declared index/trigger/policy/RLS flag still exists.
 * Safe against prod.
 *
 * Usage:
 *   npx tsx scripts/prod-endpoint-smoke.ts
 *   SMOKE_BASE_URL=http://localhost:3001 npx tsx scripts/prod-endpoint-smoke.ts
 *
 * Env — override any of these; they default to the repo's shared dev
 * credentials (the same X-API-Key / test-user id documented in CLAUDE.md and
 * used by every blackbox test + the /deploy Step 13a probe), so the script runs
 * with no setup. Set SMOKE_API_KEY / SMOKE_USER_ID to point at another env.
 *   SMOKE_BASE_URL   backend base URL     (default https://navi-j9a9.onrender.com)
 *   SMOKE_API_KEY    internal X-API-Key   (default: shared dev key, see CLAUDE.md)
 *   SMOKE_USER_ID    X-User-Id            (default: shared dev test user, see CLAUDE.md)
 */
import { config } from 'dotenv';
import { runAuthCorsPreflights } from '../src/providers/corsSmoke';
import { driftProblems, SCHEMA_DRIFT_HINT, verifySchemaObjects } from './verify-schema-objects';
config();

const RAW_BASE_URL = (process.env.SMOKE_BASE_URL ?? 'https://navi-j9a9.onrender.com').replace(
  /\/$/,
  ''
);
const ALLOW_LOCAL = process.env.SMOKE_ALLOW_LOCAL === '1';

function isLoopbackSmokeBase(rawBaseUrl: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(rawBaseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (hostname === '::1' || hostname === '[::1]' || hostname === '0:0:0:0:0:0:0:1') return true;
  // IPv4 loopback 127.0.0.0/8
  const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4 && ipv4[1] === '127') {
    const octets = ipv4.slice(1).map(Number);
    if (octets.every((n) => n >= 0 && n <= 255)) return true;
  }
  // IPv4-mapped IPv6 loopback (:ffff:127.x.x.x)
  const mapped = hostname.match(/^::ffff:(127(?:\.\d{1,3}){3})$/i);
  if (mapped) return true;
  return false;
}

const LOCAL_BASE = isLoopbackSmokeBase(RAW_BASE_URL);
if (LOCAL_BASE && !ALLOW_LOCAL) {
  console.error(
    `❌ Refusing SMOKE_BASE_URL=${RAW_BASE_URL} for production endpoint smoke.\n` +
      `   Cloud/dev environments often inject a loopback URL here; that makes every\n` +
      `   probe report fetch failed even when prod is healthy. Unset SMOKE_BASE_URL\n` +
      `   (or set it to the real prod URL), or set SMOKE_ALLOW_LOCAL=1 only when\n` +
      `   intentionally probing a local backend.`
  );
  process.exit(2);
}
const BASE_URL = RAW_BASE_URL;
// Shared dev credentials (also in CLAUDE.md + every *.blackbox.ts). Not a real
// secret; override via env to probe a different environment.
const API_KEY = process.env.SMOKE_API_KEY ?? 'AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=';
const USER_ID = process.env.SMOKE_USER_ID ?? '1f85ff25-6e29-4c1b-8739-f917bd101a30';

const REQUEST_TIMEOUT_MS = 15000;
const MAX_ATTEMPTS = 6; // ~ up to 25s of warmup retry on 5xx / network error
const RETRY_DELAY_MS = 5000;

interface Probe {
  path: string;
  domain: string;
  method?: 'GET' | 'POST';
  // If set, the final status MUST be in this list (still never 5xx). Used to
  // pin the compute-token route to the codes that mean "the lineage/affinity
  // tables were queried successfully" (200 = token, 404 = no token available).
  requireStatusIn?: number[];
}

// One representative DB-backed GET per domain. Add a line whenever you ship a
// new domain whose runtime path is independent of the ones already listed.
const PROBES: Probe[] = [
  { path: '/api/agents', domain: 'agents (Agent)' },
  { path: '/api/models', domain: 'models (RoseConversationModel)' },
  { path: '/api/benchmarks/test-prompts', domain: 'benchmarks (eval catalog)' },
  { path: '/api/user-settings', domain: 'user-settings (User)' },
  { path: '/api/attention-requests', domain: 'attention-requests' },
  { path: '/api/people', domain: 'people (Person)' },
  {
    path: '/api/tool-usage/tree/8e0c9c2e-1e95-4135-8dd4-43469b961c4f',
    domain: 'tool-usage (ToolUsage tree)',
  },
  {
    // THE 2026-07-06 regression probe: exercises ComputeTokenLineageLease +
    // ComputeTokenFastCacheAffinity. 200 (token) or 404 (none available) both
    // mean the tables were queried; 500 means the migration is missing again.
    path: '/api/integrations/compute-code/credentials/token?lineageKey=smoke:endpoint-probe&agentId=smoke-probe&rootAgentId=smoke-probe&fastCacheAffinityKey=smoke:endpoint-probe',
    domain: 'integrations/compute-code token (lineage lease + affinity)',
    requireStatusIn: [200, 404],
  },
  {
    path: '/api/integrations/compute-code/anthropic-key/cooldown',
    domain: 'integrations/compute-code cooldown',
  },
  {
    // Internal auth intentionally has no end-user identity, so this must stop
    // at the route's 401 guard before validation or analytics side effects.
    path: '/api/download-telemetry',
    domain: 'download-telemetry (authenticated ingestion boundary)',
    method: 'POST',
    requireStatusIn: [401],
  },
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ProbeResult {
  probe: Probe;
  status: number | null; // null = network error / timeout
  error?: string;
  attempts: number;
}

async function runProbe(probe: Probe): Promise<ProbeResult> {
  let lastStatus: number | null = null;
  let lastError: string | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${BASE_URL}${probe.path}`, {
        method: probe.method ?? 'GET',
        headers: { 'X-API-Key': API_KEY, 'X-User-Id': USER_ID },
        signal: controller.signal,
      });
      lastStatus = res.status;
      lastError = undefined;
      // 5xx is retryable (warmup); anything else is a settled answer.
      if (res.status < 500) return { probe, status: res.status, attempts: attempt };
    } catch (err) {
      lastStatus = null;
      lastError = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
    }
    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
  }
  return { probe, status: lastStatus, error: lastError, attempts: MAX_ATTEMPTS };
}

function isFailure(r: ProbeResult): boolean {
  if (r.status === null) return true; // network error / timeout
  if (r.status >= 500) return true;
  if (r.probe.requireStatusIn && !r.probe.requireStatusIn.includes(r.status)) return true;
  return false;
}

async function main(): Promise<void> {
  console.log(`Endpoint smoke against ${BASE_URL} (user ${USER_ID.slice(0, 8)})\n`);
  const [results, corsResults] = await Promise.all([
    Promise.all(PROBES.map(runProbe)),
    runAuthCorsPreflights(BASE_URL, fetch, REQUEST_TIMEOUT_MS),
  ]);

  let failed = 0;
  for (const r of results) {
    const fail = isFailure(r);
    if (fail) failed++;
    const statusStr = r.status === null ? `ERR(${r.error ?? 'network'})` : String(r.status);
    const mark = fail ? '❌' : '✅';
    console.log(`  ${mark} ${statusStr.padEnd(18)} ${r.probe.domain}`);
    if (fail) console.log(`       ${r.probe.path}`);
  }

  for (const result of corsResults) {
    if (!result.ok) failed++;
    const mark = result.ok ? '✅' : '❌';
    const status = result.status === null ? 'ERR' : String(result.status);
    console.log(`  ${mark} ${status.padEnd(18)} CORS ${result.origin} → ${result.path}`);
    if (!result.ok) console.log(`       ${result.error ?? 'unknown preflight failure'}`);
  }

  // Migration-declared objects Prisma cannot restore on its own (trigram
  // indexes, triggers, RLS) can vanish after `migrate deploy` recorded them,
  // e.g. through a stray `prisma db push` against prod. Check them read-only.
  let schemaChecks = 0;
  const databaseUrl = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!LOCAL_BASE && databaseUrl) {
    schemaChecks = 1;
    try {
      const problems = driftProblems(await verifySchemaObjects(databaseUrl));
      if (problems.length > 0) failed++;
      console.log(
        `  ${problems.length > 0 ? '❌' : '✅'} ${'schema'.padEnd(18)} migration-declared objects`
      );
      for (const problem of problems) console.log(`       ${problem}`);
      if (problems.length > 0) console.log(`       ${SCHEMA_DRIFT_HINT}`);
    } catch (error) {
      failed++;
      console.log(`  ❌ ${'ERR'.padEnd(18)} migration-declared objects`);
      console.log(`       ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const totalChecks = results.length + corsResults.length + schemaChecks;
  console.log(`\n${totalChecks - failed}/${totalChecks} production checks healthy.`);
  if (failed > 0) {
    console.error(
      `\n❌ ${failed} production check(s) failed.\n` +
        `   A failed endpoint or CORS preflight is a live prod incident. Check\n` +
        `   Render configuration and logs before promoting the deployment.`
    );
    process.exit(1);
  }
  console.log('✅ All probed domains healthy.');
}

main().catch((err) => {
  console.error('endpoint smoke crashed:', err);
  process.exit(1);
});
