#!/usr/bin/env tsx
/**
 * R2 lossless audit (V13) helpers: ToolUsage ledger -> archived call-site
 * mapping, argument parsing, unknown-bundle scan planning (snapshot first-seen
 * semantics) and the sharded listing that keeps huge bundles such as
 * `unbound` inside the daily time budget.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  type ArchiveSource,
  family,
  ledgerFamily,
  listAll,
} from '../../../scripts/audit-r2-lossless-core';
import { parseArgs, planBundleScan, seededRandom } from '../../../scripts/audit-r2-lossless';

const uuid = () => crypto.randomUUID();
const hex = () => crypto.randomBytes(6).toString('hex');

function testLedgerFamilies(): void {
  assert.equal(family('chat_router_after_search'), 'chat_router');
  assert.equal(family('browser_use_step_12'), 'browser_use_step_N');
  assert.equal(family(null), 'unknown');
  assert.equal(ledgerFamily({ toolName: 'chat_router', callSite: 'chat' }), 'chat_router');
  assert.equal(
    ledgerFamily({ toolName: 'explore_agent', callSite: 'summarize_web_fetch' }),
    'summarize_web_fetch'
  );
  assert.equal(ledgerFamily({ toolName: 'planner', callSite: null }), 'planner');
  // Explore rows bill browser-use steps and page summaries under toolName/call_site explore_agent.
  const explore = { toolName: 'explore_agent', callSite: 'explore_agent' };
  const seq = (suffix: string) => `browser-task:${uuid()}:${suffix}`;
  assert.equal(
    ledgerFamily({
      ...explore,
      provider: 'Rose 1 Browser Use',
      cacheSequenceId: seq('browser_use'),
    }),
    'browser_use_step_N'
  );
  assert.equal(
    ledgerFamily({ ...explore, provider: 'Rose 1 Browser Use', cacheSequenceId: null }),
    'browser_use_step_N'
  );
  assert.equal(
    ledgerFamily({ ...explore, provider: 'Rose (summarize_web_fetch)', cacheSequenceId: null }),
    'summarize_web_fetch'
  );
  assert.equal(
    ledgerFamily({
      ...explore,
      provider: 'Explore Agent',
      cacheSequenceId: `agent:${uuid()}:task:${uuid()}:call:explore_agent`,
    }),
    'explore_agent'
  );
  assert.equal(
    ledgerFamily({
      toolName: 'execute_loop',
      callSite: 'execute_loop',
      provider: null,
      cacheSequenceId: `agent:${uuid()}:call:execute_loop`,
    }),
    'execute_loop'
  );
}

function testCliPlanning(): void {
  const args = parseArgs(['--since', '2026-11-13T00:00:00Z'], Date.parse('2026-11-14T05:00:00Z'));
  assert.equal(new Date(args.untilMs).toISOString(), '2026-11-14T00:00:00.000Z');
  assert.throws(() => parseArgs(['--since', '2026-11-14T00:00Z', '--until', '2026-11-13T00:00Z']));
  assert.throws(() => parseArgs(['--delete']), /unknown argument/);

  const known = uuid();
  const child = uuid();
  const old = uuid();
  const fresh = uuid();
  const recent = uuid();
  const plan = planBundleScan(
    [known, child, old, fresh, recent, 'unbound', 'x__secret_card_cvv__y'],
    [
      { id: known, is_root: true, model: 'm' },
      { id: child, is_root: false, model: 'm' },
    ],
    new Map([
      [old, 100],
      [recent, 500],
    ]),
    200,
    10,
    false,
    () => 0.5
  );
  assert.deepEqual(plan.nonUuid, ['unbound', 'x__secret_card_cvv__y']);
  assert.deepEqual(plan.userRootBundles, []);
  assert.deepEqual(plan.childAgentBundles, [child]);
  // Never seen, or first seen at/after the window start: listed exactly; older ones sampled.
  assert.deepEqual(plan.newUnknownUuid, [fresh, recent]);
  assert.deepEqual(plan.sampledUnknownUuid, [old]);
  assert.equal(plan.unknownUuidTotal, 3);
  // The unknown-bundle sample is a pure function of the window start.
  const draw = (seed: number) => Array.from({ length: 4 }, seededRandom(seed));
  assert.deepEqual(draw(1_794_528_000_000), draw(1_794_528_000_000));
  assert.notDeepEqual(draw(1_794_528_000_000), draw(1_794_614_400_000));
  assert.ok(draw(7).every((n) => n >= 0 && n < 1));
}

/** S3 semantics with tiny pages, so `listAll` must split by directory and next character. */
function pagingSource(keys: string[], pageSize: number): ArchiveSource & { calls: number } {
  const sorted = [...keys].sort();
  const source = {
    kind: 'paging',
    calls: 0,
    async list(prefix: string, delimiter?: string, maxPages?: number) {
      source.calls += 1;
      const entries: Array<{ key?: string; prefix?: string }> = [];
      for (const key of sorted.filter((k) => k.startsWith(prefix))) {
        const slash = delimiter === undefined ? -1 : key.indexOf('/', prefix.length);
        const common = slash < 0 ? null : key.slice(0, slash + 1);
        if (common === null) entries.push({ key });
        else if (entries.at(-1)?.prefix !== common) entries.push({ prefix: common });
      }
      const limit = maxPages === undefined ? entries.length : maxPages * pageSize;
      const page = entries.slice(0, limit);
      return {
        objects: page.flatMap((e) => (e.key ? [{ key: e.key, size: 1, lastModifiedMs: 0 }] : [])),
        prefixes: page.flatMap((e) => (e.prefix ? [e.prefix] : [])),
        truncated: entries.length > limit,
      };
    },
    async get() {
      return null;
    },
  };
  return source;
}

async function testShardedListing(): Promise<void> {
  const keys = [
    'trace-archive/unbound/manifest.public.json',
    'trace-archive/unbound/llm-updates/a1-1794000000000-update.json.gz.enc',
    ...Array.from({ length: 40 }, (_, i) => `trace-archive/unbound/llm/${hex()}${i}.json.gz.enc`),
    'trace-archive/unbound/code/s/1/manifest.json',
    'trace-archive/other/llm/x.json.gz.enc',
  ];
  const small = pagingSource(keys, 1000);
  assert.equal((await listAll(small, 'trace-archive/unbound/', 4)).length, keys.length - 1);
  assert.equal(small.calls, 1); // a single-page prefix costs one request
  const tiny = pagingSource(keys, 3);
  const listed = (await listAll(tiny, 'trace-archive/unbound/', 4)).map((o) => o.key).sort();
  assert.deepEqual(listed, keys.filter((k) => k.startsWith('trace-archive/unbound/')).sort());
  assert.ok(tiny.calls > 10);
}

async function main(): Promise<void> {
  testLedgerFamilies();
  testCliPlanning();
  await testShardedListing();
  process.stdout.write('audit-r2-lossless-listing: all tests passed\n');
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
