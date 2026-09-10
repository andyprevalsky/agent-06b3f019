#!/usr/bin/env tsx
/* eslint-disable no-console */

import assert from 'node:assert';
import { bestEffortIndexPlannerMemory } from '../../providers/traceArchiveLifecycle';

async function main(): Promise<void> {
  const wrote = await bestEffortIndexPlannerMemory(
    {
      rootAgentId: 'agent-index-failure',
      userId: 'user-1',
      goal: 'Archive this completed run',
    },
    async () => {
      throw new Error('planner-memory unavailable');
    }
  );
  assert.strictEqual(wrote, false);
  console.log('  ✅ planner-memory index failure does not reject archive finalization');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
