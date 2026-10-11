#!/usr/bin/env tsx
/**
 * BROWSER_SESSION announcements order against the live-view GET by `asOf`.
 * The announcer must take `asOf` before it reads the row: a GET that read a
 * newer binding afterwards has to outrank this announcement in the FE store.
 */

import assert from 'node:assert/strict';
import { announceBrowserSessionBinding } from '../../providers/browser/sessionBindingAnnounce';

type Broadcast = Parameters<
  NonNullable<Parameters<typeof announceBrowserSessionBinding>[1]>['broadcast'] & object
>;

const row = {
  id: 'e264ec23-538b-50bb-9874-30c9830a49d8',
  agentId: '8b4d4592-c5da-4889-8a01-52824db125d1',
  sessionId: 'qzsodw10re6xto2hd8vcjxps',
  debugUrl: 'https://prod-iad-hypeman-28.kernel.sh:8443/browser/live/pmHw1BNYtFaS?readOnly=true',
  status: 'ACTIVE',
};

async function testAsOfIsCapturedBeforeTheRowRead(): Promise<void> {
  const events: string[] = [];
  const broadcasts: Broadcast[] = [];
  let clock = 1_000;
  await announceBrowserSessionBinding(
    { id: row.id },
    {
      now: () => {
        events.push('now');
        return clock;
      },
      findRow: async () => {
        events.push('read');
        clock = 2_000; // a concurrent rebind + GET happen while the row is read
        return row;
      },
      broadcast: async (...args) => {
        events.push('broadcast');
        broadcasts.push(args);
      },
    }
  );
  assert.deepEqual(events, ['now', 'read', 'broadcast']);
  assert.deepEqual(broadcasts, [
    [
      row.agentId,
      { taskId: row.id, sessionId: row.sessionId, debugUrl: row.debugUrl, status: 'ACTIVE' },
      1_000,
    ],
  ]);
}

async function testMissingRowOrFailedReadDoesNotBroadcastOrThrow(): Promise<void> {
  let broadcasts = 0;
  const broadcast = async () => {
    broadcasts += 1;
  };
  await announceBrowserSessionBinding(
    { sessionId: 'gone' },
    { findRow: async () => null, broadcast }
  );
  await announceBrowserSessionBinding(
    { id: row.id },
    {
      findRow: async () => {
        throw new Error('database unavailable');
      },
      broadcast,
    }
  );
  assert.equal(broadcasts, 0);
}

async function main(): Promise<void> {
  const cases: Array<[string, () => Promise<void>]> = [
    ['asOf is captured before the row read', testAsOfIsCapturedBeforeTheRowRead],
    [
      'missing row or failed read neither broadcasts nor throws',
      testMissingRowOrFailedReadDoesNotBroadcastOrThrow,
    ],
  ];
  let failed = 0;
  for (const [name, fn] of cases) {
    try {
      await fn();
      process.stdout.write(`PASS ${name}\n`);
    } catch (error) {
      failed += 1;
      process.stdout.write(
        `FAIL ${name}: ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
  }
  process.exit(failed > 0 ? 1 : 0);
}

void main();
