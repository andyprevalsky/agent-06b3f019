#!/usr/bin/env tsx

/**
 * Chat escalation after start_superintelligence must not await a hung
 * persist/start forever. A deadline that fires must reject so the fire-and-forget
 * chat handler can fail the agent instead of leaving ACTIVE + null workflow.
 */

import assert from 'node:assert/strict';
import { withChatEscalationDeadline } from '../../providers/chat/chatEscalationDeadline';

async function main(): Promise<void> {
  await assert.rejects(
    () => withChatEscalationDeadline(() => new Promise(() => undefined), 20),
    /Chat escalation exceeded 20ms without starting a workflow/
  );

  const value = await withChatEscalationDeadline(async () => 'started', 50);
  assert.equal(value, 'started');

  process.stdout.write('PASS chat escalation deadline rejects a hung persist/start\n');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
