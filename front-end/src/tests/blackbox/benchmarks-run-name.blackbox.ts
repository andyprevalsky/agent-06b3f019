/**
 * Blackbox tests for the Benchmark Hub's semantic run label (deriveRunName),
 * split from benchmarks-hub.blackbox.tsx to keep that file under max-lines.
 */
import { describe, it, expect } from 'vitest';
import { deriveRunName } from '@/features/benchmarks/runName';
import type { HubRun } from '@/lib/api/benchmarksHub';

describe('deriveRunName (semantic run label)', () => {
  const mkRun = (over: Partial<HubRun>): HubRun => ({
    run_id: '20260719-131303-17378',
    timestamp: '2026-07-19T20:13:03Z',
    suite: 'cloud-fleet',
    source: 'cloud-fleet',
    live: false,
    uploaded_at: '2026-07-19T20:40:00Z',
    tasks: [],
    ...over,
  });
  const task = (name: string): HubRun['tasks'][number] => ({
    name,
    passed: null,
    status: 'queued',
    agent_id: null,
    duration_seconds: null,
    cost_cents: null,
    world_model_mode: null,
    fast_mode: false,
    tree_agent_count: null,
    failure_reason: null,
  });

  it('prefers an explicit bundle name over derivation', () => {
    expect(deriveRunName(mkRun({ name: 'ecommerce slice', tasks: [task('a'), task('b')] }))).toBe(
      'ecommerce slice',
    );
  });

  it('uses the single task name for a one-task run', () => {
    expect(deriveRunName(mkRun({ tasks: [task('browser-amazon-return')] }))).toBe(
      'browser-amazon-return',
    );
  });

  it('joins up to three distinct task names', () => {
    expect(deriveRunName(mkRun({ tasks: [task('a'), task('b'), task('c')] }))).toBe('a, b, c');
  });

  it('summarizes longer slices as "first, second +N more" and dedupes', () => {
    const tasks = [task('a'), task('b'), task('a'), task('c'), task('d')]; // 4 distinct
    expect(deriveRunName(mkRun({ tasks }))).toBe('a, b +2 more');
  });

  it('falls back to suite/source when there are no tasks', () => {
    expect(deriveRunName(mkRun({ tasks: [] }))).toBe('cloud-fleet');
    expect(deriveRunName(mkRun({ tasks: [], suite: null, source: 'manual-run' }))).toBe(
      'manual-run',
    );
    expect(deriveRunName(mkRun({ tasks: [], suite: null, source: null }))).toBe('run');
  });
});
