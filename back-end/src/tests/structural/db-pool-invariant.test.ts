import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { computeProdConnectionLimit } from '../../providers/database';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(__dirname, '../../..');

// Cements the Supavisor client-connection invariant that the prod Prisma pool
// size is derived from (see providers/database.ts). A regression here means a
// deploy or a scale-out could exhaust the pooler's client cap and reproduce the
// `FATAL: (EMAXCONN) max client connections reached` incident.
//
//   backendInstances * DEPLOY_OVERLAP * (connection_limit + DEMO_CACHE_POOL_LIMIT)
//     + RESERVED <= maxClientConn
//
// Each backend instance holds TWO Prisma pools against the pooler in prod: the
// main pool and the DEMO cache pool (demoCacheStore.ts falls back to
// DATABASE_URL in production). The Fly agent fleet is deliberately absent —
// workers reach the DB only over the backend HTTP API and hold zero DB
// connections; a rolling deploy is the only time two backend instances run at
// once.
const DEPLOY_OVERLAP = 2;
// Pin the code-default demo-cache size (database.ts intEnv fallback). Do NOT
// read DEMO_CACHE_POOL_LIMIT / process.env here — cloud shells inject
// FAST_CACHE_DB_POOL=150 which would poison these hardcoded 400-cap scenarios.
const CANONICAL_DEMO_CACHE_POOL = 75;
// The 400-cap scenarios model a pooler tier with no room for non-production
// clients; they pin the production-only arithmetic.
const NO_NONPROD_SLICE = 0;

function totalFootprint(maxClientConn: number, backendInstances: number, reserved: number): number {
  const limit = computeProdConnectionLimit({
    maxClientConn,
    backendInstances,
    reserved,
    deployOverlap: DEPLOY_OVERLAP,
    demoCachePool: CANONICAL_DEMO_CACHE_POOL,
    nonProdBudget: NO_NONPROD_SLICE,
  });
  return backendInstances * DEPLOY_OVERLAP * (limit + CANONICAL_DEMO_CACHE_POOL) + reserved;
}

// The invariant must hold across our real config and plausible near-term
// scale-outs, so raising BACKEND_INSTANCES can never silently blow the cap.
// (Beyond 2 instances the 75-conn demo-cache pool per instance dominates the
// 400 budget — scaling past that requires moving demo-cache off the shared
// pooler, which this test will flag by failing.)
function testInvariantHoldsAcrossFleetSizes() {
  const maxClientConn = 400;
  const reserved = 40;
  for (let instances = 1; instances <= 2; instances++) {
    const footprint = totalFootprint(maxClientConn, instances, reserved);
    assert(
      footprint <= maxClientConn,
      `Pool invariant violated at ${instances} backend instance(s): ` +
        `total client-connection footprint ${footprint} exceeds ${maxClientConn}`
    );
  }
}

// A single fat backend (our current prod topology) must survive its own rolling
// deploy: two instances, each holding BOTH pools, must fit under the 400 cap
// with the reserve intact. This is the exact scenario the historical incidents
// hit (2 x (250 + 75) = 650 > 400).
function testCurrentProdTopologySurvivesDeployOverlap() {
  const maxClientConn = 400;
  const reserved = 40;
  const limit = computeProdConnectionLimit({
    maxClientConn,
    backendInstances: 1,
    reserved,
    deployOverlap: DEPLOY_OVERLAP,
    demoCachePool: CANONICAL_DEMO_CACHE_POOL,
    nonProdBudget: NO_NONPROD_SLICE,
  });
  assert(limit >= 40, `Single-instance limit should leave real request headroom, got ${limit}`);
  assert(
    2 * (limit + CANONICAL_DEMO_CACHE_POOL) + reserved <= maxClientConn,
    `Deploy overlap 2 x (${limit} + ${CANONICAL_DEMO_CACHE_POOL}) + reserved ${reserved} must fit under ${maxClientConn}`
  );
}

// A fleet that cannot fit under the cap must FAIL FAST at boot, not clamp to a
// floor: clamped pools would still open floor+demoCache connections per
// instance and blow the cap at the next deploy — the exact EMAXCONN failure
// this derivation prevents. (e.g. 10 instances under a 400 cap: clamping to 10
// would open 10x2x(10+75)+40 = 1740 connections.)
function testThrowsWhenFleetCannotFitUnderCap() {
  assert.throws(
    () =>
      computeProdConnectionLimit({
        maxClientConn: 400,
        backendInstances: 10,
        reserved: 40,
        deployOverlap: DEPLOY_OVERLAP,
        demoCachePool: 75,
        nonProdBudget: NO_NONPROD_SLICE,
      }),
    /pool budget violation/i,
    '10 instances with a 75-conn demo-cache pool cannot fit under a 400 cap — must throw'
  );
  assert.throws(
    () =>
      computeProdConnectionLimit({
        maxClientConn: 50,
        backendInstances: 100,
        reserved: 40,
        deployOverlap: DEPLOY_OVERLAP,
      }),
    /pool budget violation/i,
    'absurd config (tiny cap, huge fleet) must throw'
  );
  // Non-finite / non-positive inputs must be rejected, not laundered into an
  // Infinity/NaN limit that slips past the budget check.
  assert.throws(
    () => computeProdConnectionLimit({ backendInstances: 0 }),
    /finite positive/i,
    'zero instances must throw, not divide to Infinity'
  );
  assert.throws(
    () => computeProdConnectionLimit({ deployOverlap: Number.NaN }),
    /finite positive/i,
    'NaN overlap must throw'
  );
}

// The canonical prod defaults (400-cap pooler, 1 instance, 75 demo-cache) must
// land on a deploy-safe, non-trivial main-pool size — guards against someone
// re-hardcoding a cap-busting number like 250. Explicit opts so a cloud shell's
// FAST_CACHE_DB_POOL / POOLER_MAX_CLIENT_CONN injections cannot poison the gate.
function testDefaultProdLimitIsDeploySafe() {
  const limit = computeProdConnectionLimit({
    maxClientConn: 400,
    backendInstances: 1,
    reserved: 40,
    deployOverlap: DEPLOY_OVERLAP,
    demoCachePool: CANONICAL_DEMO_CACHE_POOL,
    nonProdBudget: NO_NONPROD_SLICE,
  });
  assert(limit > 10, `Default prod limit should be well above the floor, got ${limit}`);
  assert(
    2 * (limit + CANONICAL_DEMO_CACHE_POOL) <= 400,
    `Default prod limit ${limit} + demo-cache ${CANONICAL_DEMO_CACHE_POOL} must survive a 2x deploy overlap under a 400 cap`
  );
}

// Production shares the Supavisor client cap with every dev and benchmark stack
// (same pooler, same `postgres` user). Production's live Render settings
// (POOLER_MAX_CLIENT_CONN=1000, FAST_CACHE_DB_POOL=150, one instance) must leave
// the documented non-production worst case free even during a rolling deploy:
// a 50-guest DEMO fleet at 4 clients (cloudbench-run.sh) plus five dev or
// benchmark stacks at 20 (fast-mode-cache-schema.sh). Before 2026-10-27 the
// derivation budgeted 2 x (330 + 150) + 40 = 1000 of 1000 for production alone,
// so any non-production client during a deploy overlap could cause EMAXCONN.
const NONPROD_WORST_CASE_CLIENTS = 50 * 4 + 5 * 20;
function testProdLeavesNonProdSliceAtLiveSettings() {
  const maxClientConn = 1000;
  const demoCachePool = 150;
  const reserved = 40;
  const limit = computeProdConnectionLimit({
    maxClientConn,
    backendInstances: 1,
    reserved,
    deployOverlap: DEPLOY_OVERLAP,
    demoCachePool,
  });
  const prodWorstCase = DEPLOY_OVERLAP * (limit + demoCachePool) + reserved;
  assert(
    prodWorstCase + NONPROD_WORST_CASE_CLIENTS <= maxClientConn,
    `Production budgets ${prodWorstCase} of ${maxClientConn} pooler clients during a deploy ` +
      `overlap, leaving ${maxClientConn - prodWorstCase} for the ${NONPROD_WORST_CASE_CLIENTS}-client ` +
      'non-production worst case'
  );
  assert(limit >= 100, `Production main pool must keep real request headroom, got ${limit}`);
}

// demoCacheStore.ts must size its pool from the shared DEMO_CACHE_POOL_LIMIT
// constant — a hand-rolled connection_limit there would silently desync the
// budget math in database.ts from the pool that actually opens.
function testDemoCachePoolUsesSharedConstant() {
  const source = fs.readFileSync(path.join(backendDir, 'src/providers/demoCacheStore.ts'), 'utf8');
  assert(
    /import\s*\{[^}]*DEMO_CACHE_POOL_LIMIT[^}]*\}\s*from\s*'\.\/database'/.test(source),
    'demoCacheStore must import DEMO_CACHE_POOL_LIMIT from providers/database'
  );
  assert(
    source.includes("set('connection_limit', String(DEMO_CACHE_POOL_LIMIT))"),
    'demoCacheStore must set its connection_limit from DEMO_CACHE_POOL_LIMIT'
  );
  assert(
    !/FAST_CACHE_DB_POOL/.test(source),
    'demoCacheStore must not read FAST_CACHE_DB_POOL directly — the env var is owned by providers/database'
  );
}

function main() {
  testInvariantHoldsAcrossFleetSizes();
  testCurrentProdTopologySurvivesDeployOverlap();
  testThrowsWhenFleetCannotFitUnderCap();
  testDefaultProdLimitIsDeploySafe();
  testDemoCachePoolUsesSharedConstant();
  testProdLeavesNonProdSliceAtLiveSettings();
}

try {
  main();
  process.stdout.write('db pool invariant structural tests passed\n');
} catch (error: unknown) {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
}
