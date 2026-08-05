#!/usr/bin/env tsx
/* eslint-disable no-console */

/**
 * Regression: pre-deploy cleanup MUST NOT terminate live prod workflows.
 *
 * Incident (agent e14d5abb-1ff9-40f2-a910-2d3a1e9bb1cc): a live PROD agent was
 * sleeping on a scheduled wait_for (Temporal timer id=2 due 2026-08-03T17:00:00Z,
 * = 10:00 AM America/Los_Angeles). At 2026-08-03T16:03:50Z — 57 minutes before
 * the timer fired — `cleanup-stale-workspaces.ts` TERMINATED it with reason
 * "Deploy cleanup: stale workspace workflow". The agent was only resurrected by
 * the next deploy's replacement bootstrap at 2026-08-04T02:21Z, so the scheduled
 * message was sent ~9.4h late.
 *
 * Root cause: prod/workspace workers register under Temporal Worker Versioning,
 * so `workflow.list()` reports the task queue as `<queue>@<build-id>`
 * (observed: `navi-agent-tasks@ebdc7ba275e9`). The "never touch prod" guard used
 * exact equality (`queue === 'navi-agent-tasks'`), which missed the build-id
 * suffix, so the prod workflow fell through to "stale — terminate".
 *
 * This test drives the real classification predicate. It fails on the exact-
 * equality guard and passes once the predicate compares the base queue name.
 */
import assert from 'node:assert/strict';
import { classifyCleanupQueue } from '../../utils/staleWorkflowQueue';

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✅ ${name}`);
  } catch (error) {
    console.error(`  ❌ ${name}`);
    throw error;
  }
}

test('protects prod workflows on the exact incident build-id-versioned queue', () => {
  assert.equal(
    classifyCleanupQueue('navi-agent-tasks@ebdc7ba275e9', new Set(['raleigh'])),
    'skip-prod'
  );
});

test('protects the bare prod queue (unversioned)', () => {
  assert.equal(classifyCleanupQueue('navi-agent-tasks', new Set()), 'skip-prod');
});

test('protects active workspace queues even when build-id versioned', () => {
  assert.equal(
    classifyCleanupQueue('navi-agent-tasks-raleigh@ebdc7ba275e9', new Set(['raleigh'])),
    'skip-active'
  );
});

test('still terminates a genuinely stale (archived) workspace queue', () => {
  assert.equal(
    classifyCleanupQueue('navi-agent-tasks-archived-ws@ebdc7ba275e9', new Set(['raleigh'])),
    'terminate'
  );
});

test('still terminates a fully unknown queue', () => {
  assert.equal(classifyCleanupQueue('some-other-queue', new Set(['raleigh'])), 'terminate');
});

console.log('stale workflow queue classification tests passed');
