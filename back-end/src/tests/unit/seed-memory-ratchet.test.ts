import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PROD_WORKER_MEMORY_MB,
  SEED_MAX_MACHINE_FRACTION,
  SEED_PEAK_RSS_CEILING_MB,
  SEED_PEAK_RSS_BUDGET_MB,
  SEED_RSS_HEADROOM_RATIO,
  withinSeedBudget,
} from '../../providers/seedMemoryBudget';

const SEED_SOURCE = readFileSync(join(__dirname, '../../../scripts/seed-local.ts'), 'utf8');

function test(name: string, run: () => void): void {
  run();
  process.stdout.write(`PASS seed-memory-ratchet: ${name}\n`);
}

test('budget leaves the rest of the stack room on a fleet primary', () => {
  // The seed is one of several services on the box (Postgres, Temporal,
  // backend, frontend, 12 worker processes). Taking more than a fifth of the
  // machine at peak is what produced the rc=137 SIGKILL on 2026-07-29.
  // Anchored to PROD's 2048MB worker, not the 4096MB bench primary. The
  // fleet box already has 2x prod's RAM and still OOM'd; budgeting against
  // the bigger machine would license the seed to keep growing into it.
  assert.equal(SEED_PEAK_RSS_CEILING_MB, PROD_WORKER_MEMORY_MB * SEED_MAX_MACHINE_FRACTION);
  assert.ok(SEED_PEAK_RSS_BUDGET_MB <= SEED_PEAK_RSS_CEILING_MB);
});

test('ratchets down only — never raise the budget to make a run pass', () => {
  // A seed needing more RAM is a seed that must get leaner: machine size is
  // pinned to what prod uses, and autoscaling must stay intact. This is the
  // high-water mark; if you are editing it upward, fix the seed instead.
  const HIGH_WATER_MB = 400;
  assert.ok(SEED_PEAK_RSS_BUDGET_MB <= HIGH_WATER_MB);
  assert.equal(SEED_RSS_HEADROOM_RATIO, 0.2);
  assert.equal(SEED_PEAK_RSS_BUDGET_MB, Math.ceil(190 * (1 + SEED_RSS_HEADROOM_RATIO)));
});

test('every large table is paged, not materialised', () => {
  // Peak heap must be bounded by (page size x row size), never by table size.
  // `findMany({ take: 10_000 })` on MessageRecord held every row and its
  // message body in one array before the first write.
  assert.doesNotMatch(SEED_SOURCE, /take:\s*MESSAGE_LIMIT/);
  assert.ok(SEED_SOURCE.includes("positivePageSize('SEED_MESSAGE_PAGE_SIZE', 50)"));
  // A larger SEED_MESSAGE_LIMIT only adds pages; the default stays the latest 10k.
  assert.ok(SEED_SOURCE.includes("positivePageSize('SEED_MESSAGE_LIMIT', 10_000)"));
  // Paged loops must advance by their page size and stop on a short page.
  assert.match(SEED_SOURCE, /skip \+= MESSAGE_PAGE_SIZE/);
  assert.match(SEED_SOURCE, /page\.length < MESSAGE_PAGE_SIZE/);
  // Offset pages need a total order: equal timestamps must not cross a page
  // boundary in a different order and repeat or skip a message.
  assert.ok(SEED_SOURCE.includes("orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],"));
  assert.doesNotMatch(SEED_SOURCE, /orderBy: \{ timestamp: 'desc' \},\s*skip,/);
});

test('large JSONB never materializes in the Node process', () => {
  for (const table of ['LocalStorageOrigin', 'IndexedDBOrigin', 'CacheStorageOrigin']) {
    assert.ok(SEED_SOURCE.includes(`syncJsonbOriginTable('${table}')`));
  }
  assert.ok(!SEED_SOURCE.includes('scopedRemoteBrowserAuth.localStorageOrigin('));
  assert.ok(!SEED_SOURCE.includes('scopedRemoteBrowserAuth.indexedDBOrigin('));
  assert.ok(!SEED_SOURCE.includes('scopedRemoteBrowserAuth.cacheStorageOrigin('));
});

test('cookies stream between databases instead of paging through Prisma', () => {
  // A ~22k-cookie account made paging a false choice: 25 rows/page cost ~880
  // production round trips (past the deploy stack's 120s readiness contract)
  // and 500 rows/page measured a 239MB peak against the former 230MB budget. COPY
  // pays one round trip and keeps every cookie row out of the V8 heap, so the
  // budget never has to move.
  assert.ok(SEED_SOURCE.includes('streamCookies({'));
  assert.ok(!SEED_SOURCE.includes('scopedRemoteBrowserAuth.cookie('));
  assert.ok(!SEED_SOURCE.includes('local.cookie.createMany'));
  assert.ok(!SEED_SOURCE.includes('syncCookieCredentials('));
});

test('no growth table is loaded whole — paging preserves every row', () => {
  // "Hyper efficient" here means STREAMED, not sampled: paging changes peak
  // heap, never row count, so there is no fidelity loss. These tables grow
  // with real usage, so a whole-table load is a latent OOM on any box.
  const GROWTH_TABLES = ['messageRecord', 'person', 'cookie', 'localStorageOrigin'];
  for (const table of GROWTH_TABLES) {
    const calls = SEED_SOURCE.match(new RegExp(`${table}\\.findMany\\(([^)]|\\n)*?\\)`, 'g')) ?? [];
    for (const call of calls) {
      // `pagedOriginArgs` is main's rename of the origin pager; it still applies
      // skip/take, so it counts as paged.
      const paged =
        call.includes('skip') ||
        call.includes('pagedArgs') ||
        call.includes('pagedOriginArgs') ||
        call.includes('select:');
      assert.ok(paged, `${table}.findMany must page (or select only keys): ${call.slice(0, 90)}`);
    }
  }
});

test('reports its own peak so a regression names the table', () => {
  assert.ok(SEED_SOURCE.includes('seed peak RSS'));
  assert.ok(SEED_SOURCE.includes('sampleRss'));
  // Instrumentation must never be what fails a successful seed.
  assert.match(SEED_SOURCE, /Loud, but NOT fatal/);
});

test('withinSeedBudget gates on the recorded budget', () => {
  assert.equal(withinSeedBudget(SEED_PEAK_RSS_BUDGET_MB), true);
  assert.equal(withinSeedBudget(SEED_PEAK_RSS_BUDGET_MB + 1), false);
});

test('resolved TSX stays within the seed budget with a large expired cache', () => {
  const backend = join(__dirname, '../../..');
  const resolve = createRequire(join(backend, 'package.json'));
  const temporary = mkdtempSync(join(tmpdir(), 'seed-tsx-cache-'));
  const entry = join(temporary, 'entry.ts');
  const preload = join(backend, 'scripts/fixtures/seed-tsx-cache-cohort.cjs');
  try {
    const marker = `SEED_TSX_CACHE_ENTRY:${temporary}`;
    writeFileSync(
      entry,
      `const marker: string = ${JSON.stringify(marker)}; console.log(marker);\n`
    );
    const result = spawnSync(process.execPath, [resolve.resolve('tsx/cli'), entry], {
      cwd: backend,
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        TMPDIR: temporary,
        TSX_DISABLE_CACHE: '',
        NODE_OPTIONS: `--max-old-space-size=96 --require ${JSON.stringify(preload)}`,
      },
    });
    assert.equal(result.status, 0, `TSX cache startup failed: ${result.error ?? result.stderr}`);
    assert(result.stdout.split(/\r?\n/).includes(marker), 'actual TypeScript entry must execute');
    const enumerated = [...result.stdout.matchAll(/CACHE_PROBE_ENUMERATED=(\d+)/g)].map((m) =>
      Number(m[1])
    );
    assert(
      enumerated.some((count) => count >= 60_000),
      'loader must enumerate the expired cache cohort'
    );
    const peaks = [...result.stdout.matchAll(/CACHE_PROBE_RSS_KB=(\d+)/g)].map((m) => Number(m[1]));
    assert(peaks.length > 0, 'child must report OS maximum RSS');
    assert(
      Math.max(...peaks) / 1024 <= SEED_PEAK_RSS_BUDGET_MB,
      `TSX cache startup exceeds unchanged ${SEED_PEAK_RSS_BUDGET_MB}MB seed budget`
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
