import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
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

describe('seed memory ratchet', () => {
  it('budget leaves the rest of the stack room on a fleet primary', () => {
    // The seed is one of several services on the box (Postgres, Temporal,
    // backend, frontend, 12 worker processes). Taking more than a fifth of the
    // machine at peak is what produced the rc=137 SIGKILL on 2026-07-29.
    // Anchored to PROD's 2048MB worker, not the 4096MB bench primary. The
    // fleet box already has 2x prod's RAM and still OOM'd; budgeting against
    // the bigger machine would license the seed to keep growing into it.
    expect(SEED_PEAK_RSS_CEILING_MB).toBe(PROD_WORKER_MEMORY_MB * SEED_MAX_MACHINE_FRACTION);
    expect(SEED_PEAK_RSS_BUDGET_MB).toBeLessThanOrEqual(SEED_PEAK_RSS_CEILING_MB);
  });

  it('ratchets down only — never raise the budget to make a run pass', () => {
    // A seed needing more RAM is a seed that must get leaner: machine size is
    // pinned to what prod uses, and autoscaling must stay intact. This is the
    // high-water mark; if you are editing it upward, fix the seed instead.
    const HIGH_WATER_MB = 400;
    expect(SEED_PEAK_RSS_BUDGET_MB).toBeLessThanOrEqual(HIGH_WATER_MB);
    expect(SEED_RSS_HEADROOM_RATIO).toBe(0.2);
    expect(SEED_PEAK_RSS_BUDGET_MB).toBe(Math.ceil(191 * (1 + SEED_RSS_HEADROOM_RATIO)));
  });

  it('every large table is paged, not materialised', () => {
    // Peak heap must be bounded by (page size x row size), never by table size.
    // `findMany({ take: 10_000 })` on MessageRecord held every row and its
    // message body in one array before the first write.
    expect(SEED_SOURCE).not.toMatch(/take:\s*MESSAGE_LIMIT/);
    expect(SEED_SOURCE).toContain("positivePageSize('SEED_MESSAGE_PAGE_SIZE', 50)");
    // Paged loops must advance by their page size and stop on a short page.
    expect(SEED_SOURCE).toMatch(/skip \+= MESSAGE_PAGE_SIZE/);
    expect(SEED_SOURCE).toMatch(/page\.length < MESSAGE_PAGE_SIZE/);
  });

  it('large JSONB never materializes in the Node process', () => {
    for (const table of ['LocalStorageOrigin', 'IndexedDBOrigin', 'CacheStorageOrigin']) {
      expect(SEED_SOURCE).toContain(`syncJsonbOriginTable('${table}')`);
    }
    expect(SEED_SOURCE).not.toContain('scopedRemoteBrowserAuth.localStorageOrigin(');
    expect(SEED_SOURCE).not.toContain('scopedRemoteBrowserAuth.indexedDBOrigin(');
    expect(SEED_SOURCE).not.toContain('scopedRemoteBrowserAuth.cacheStorageOrigin(');
  });

  it('no growth table is loaded whole — paging preserves every row', () => {
    // "Hyper efficient" here means STREAMED, not sampled: paging changes peak
    // heap, never row count, so there is no fidelity loss. These tables grow
    // with real usage, so a whole-table load is a latent OOM on any box.
    const GROWTH_TABLES = ['messageRecord', 'person', 'cookie', 'localStorageOrigin'];
    for (const table of GROWTH_TABLES) {
      const calls =
        SEED_SOURCE.match(new RegExp(`${table}\\.findMany\\(([^)]|\\n)*?\\)`, 'g')) ?? [];
      for (const call of calls) {
        const paged =
          call.includes('skip') || call.includes('pagedArgs') || call.includes('select:');
        expect(
          paged,
          `${table}.findMany must page (or select only keys): ${call.slice(0, 90)}`
        ).toBe(true);
      }
    }
  });

  it('reports its own peak so a regression names the table', () => {
    expect(SEED_SOURCE).toContain('seed peak RSS');
    expect(SEED_SOURCE).toContain('sampleRss');
    // Instrumentation must never be what fails a successful seed.
    expect(SEED_SOURCE).toMatch(/Loud, but NOT fatal/);
  });

  it('withinSeedBudget gates on the recorded budget', () => {
    expect(withinSeedBudget(SEED_PEAK_RSS_BUDGET_MB)).toBe(true);
    expect(withinSeedBudget(SEED_PEAK_RSS_BUDGET_MB + 1)).toBe(false);
  });
});
