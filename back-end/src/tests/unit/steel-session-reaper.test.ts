#!/usr/bin/env tsx
/**
 * Steel sessions bill until released. Every session we create carries this
 * environment's ownership marker in its id, and the reaper releases only the
 * sessions we own that no task or in-flight operation still holds.
 *
 * Run: npx tsx src/tests/unit/steel-session-reaper.test.ts
 */

import assert from 'node:assert';
import { buildSteelRecoveryBrowserOptions } from '../../providers/steel/sessionRecovery';
import {
  inFlightSteelSessionIds,
  localInFlightSteelSessionIds,
  isOwnedSteelSessionId,
  newOwnedSteelSessionId,
  registerInFlightSteelSession,
  unregisterInFlightSteelSession,
  steelEnvironmentIdentity,
  steelOwnershipMarker,
} from '../../providers/steel/sessionIdentity';
import {
  STEEL_REAPER_MIN_AGE_MS,
  reconcileOrphanedSteelSessions,
} from '../../providers/steel/sessionReaper';

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ✅ ${name}\n`);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    process.stdout.write(`  ❌ ${name}\n`);
  }
}

async function main(): Promise<void> {
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  await test('an in-flight registration only has to outlive setup', async () => {
    const sessionId = newOwnedSteelSessionId();
    await registerInFlightSteelSession(sessionId);
    assert.ok((await inFlightSteelSessionIds([sessionId])).has(sessionId));
    assert.ok(localInFlightSteelSessionIds(Date.now() + 19 * 60 * 1000).has(sessionId));
    // A committed BrowserSession row holds the session from then on; a stale
    // entry must not keep growing the map or shield the session from the reaper.
    assert.ok(!localInFlightSteelSessionIds(Date.now() + 21 * 60 * 1000).has(sessionId));
    await unregisterInFlightSteelSession(sessionId);
    assert.ok(!(await inFlightSteelSessionIds([sessionId])).has(sessionId));
  });

  await test('a stack with no distinct identity never reaps', async () => {
    const summary = await reconcileOrphanedSteelSessions({
      identity: () => 'local',
      listLiveSessions: async () => {
        throw new Error('must not list sessions without a distinct identity');
      },
    });
    assert.strictEqual(summary.released, 0);
    assert.strictEqual(summary.live, 0);
  });

  await test('each environment gets its own marker, most specific first', () => {
    // Local back-end/.env carries RENDER_SERVICE_ID for the Render API scripts;
    // only Render itself (RENDER=true) makes it production's identity, or a
    // developer stack would share production's marker and reap its sessions.
    assert.strictEqual(
      steelEnvironmentIdentity({ RENDER_SERVICE_ID: 'srv-1', CONDUCTOR_WORKSPACE_NAME: 'ws' }),
      'workspace:ws'
    );
    assert.strictEqual(
      steelEnvironmentIdentity({ RENDER: 'true', RENDER_SERVICE_ID: 'srv-1' }),
      'render:srv-1'
    );
    assert.strictEqual(steelEnvironmentIdentity({ RENDER_SERVICE_ID: 'srv-1' }), 'local');
    assert.strictEqual(
      steelEnvironmentIdentity({
        BENCHMARK_ISOLATED_RUN: 'true',
        BENCHMARK_RUN_ID: 'run-7',
        CONDUCTOR_WORKSPACE_NAME: 'ws',
      }),
      'benchmark:run-7'
    );
    assert.strictEqual(
      steelEnvironmentIdentity({ CONDUCTOR_WORKSPACE_NAME: 'ws' }),
      'workspace:ws'
    );
    assert.strictEqual(steelEnvironmentIdentity({}), 'local');
    assert.notStrictEqual(
      steelOwnershipMarker('render:srv-1'),
      steelOwnershipMarker('workspace:ws')
    );
    assert.match(steelOwnershipMarker('render:srv-1'), /^[0-9a-f]{8}$/);
  });

  await test('owned ids are valid v4 UUIDs that only their own environment recognises', () => {
    const prod = steelOwnershipMarker('render:srv-1');
    const local = steelOwnershipMarker('workspace:ws');
    const id = newOwnedSteelSessionId(prod);
    assert.match(id, UUID_V4, id);
    assert.ok(isOwnedSteelSessionId(id, prod));
    assert.ok(!isOwnedSteelSessionId(id, local));
    assert.ok(
      !isOwnedSteelSessionId('31920031-9d66-40b6-8e70-047c1d28f0d6', prod),
      'random ids are not ours'
    );
    assert.notStrictEqual(newOwnedSteelSessionId(prod), id, 'ids are unique');
  });

  await test('every Steel session we create asks for an owned id', () => {
    const options = buildSteelRecoveryBrowserOptions({ proxy: true });
    assert.ok(isOwnedSteelSessionId(options.sessionId), 'recovery candidates carry the marker');
  });

  await test('the reaper releases only owned, old, unheld sessions', async () => {
    const marker = steelOwnershipMarker('render:srv-1');
    const now = Date.parse('2026-10-05T12:00:00Z');
    const old = new Date(now - STEEL_REAPER_MIN_AGE_MS - 1).toISOString();
    const young = new Date(now - 60_000).toISOString();
    const orphan = newOwnedSteelSessionId(marker);
    const heldByTask = newOwnedSteelSessionId(marker);
    const inFlight = newOwnedSteelSessionId(marker);
    const tooYoung = newOwnedSteelSessionId(marker);
    const neighbour = '31920031-9d66-40b6-8e70-047c1d28f0d6';
    const released: string[] = [];
    const summary = await reconcileOrphanedSteelSessions({
      // Pin the identity the marker was built from; ambient env must not decide.
      identity: () => 'render:srv-1',
      listLiveSessions: async () => [
        { id: orphan, createdAt: old },
        { id: heldByTask, createdAt: old },
        { id: inFlight, createdAt: old },
        { id: tooYoung, createdAt: young },
        { id: neighbour, createdAt: old },
      ],
      heldSessionIds: async (candidates) => {
        assert.ok(!candidates.includes(neighbour), 'never looks up a neighbour');
        assert.ok(!candidates.includes(tooYoung), 'never looks up a session still being set up');
        return new Set([heldByTask]);
      },
      inFlightSessionIds: () => new Set([inFlight]),
      isOwned: (id) => isOwnedSteelSessionId(id, marker),
      release: async (id) => {
        released.push(id);
      },
      now: () => now,
    });
    assert.deepStrictEqual(released, [orphan]);
    assert.deepStrictEqual(
      { ...summary, releasedIds: summary.releasedIds.length },
      { live: 5, owned: 4, released: 1, failed: 0, skippedHeld: 2, skippedYoung: 1, releasedIds: 1 }
    );
  });

  await test('a session whose row commits during the held-row query is still protected', async () => {
    // createSessionWithContext registers the id in-flight, persists the row, then
    // unregisters. If the reaper read in-flight AFTER the DB query, a session that
    // committed between the two reads would be in neither set and get released.
    const marker = steelOwnershipMarker('render:srv-1');
    const now = Date.parse('2026-10-05T12:00:00Z');
    const old = new Date(now - STEEL_REAPER_MIN_AGE_MS - 1).toISOString();
    const committing = newOwnedSteelSessionId(marker);
    const inFlight = new Set([committing]);
    const released: string[] = [];
    const summary = await reconcileOrphanedSteelSessions({
      // Pin the identity the marker was built from; ambient env must not decide.
      identity: () => 'render:srv-1',
      listLiveSessions: async () => [{ id: committing, createdAt: old }],
      heldSessionIds: async () => {
        // The row commits and the id is unregistered while this query runs; the
        // query itself still predates the commit and returns no held row.
        inFlight.delete(committing);
        return new Set();
      },
      inFlightSessionIds: () => new Set(inFlight),
      isOwned: (id) => isOwnedSteelSessionId(id, marker),
      release: async (id) => {
        released.push(id);
      },
      now: () => now,
    });
    assert.deepStrictEqual(released, [], 'a live session mid-commit must not be released');
    assert.strictEqual(summary.skippedHeld, 1);
  });

  await test('a failed release is counted, not thrown, so the other sessions still get released', async () => {
    const marker = steelOwnershipMarker('render:srv-1');
    const now = Date.now();
    const old = new Date(now - STEEL_REAPER_MIN_AGE_MS - 1).toISOString();
    const a = newOwnedSteelSessionId(marker);
    const b = newOwnedSteelSessionId(marker);
    const released: string[] = [];
    const summary = await reconcileOrphanedSteelSessions({
      // Pin the identity the marker was built from; ambient env must not decide.
      identity: () => 'render:srv-1',
      listLiveSessions: async () => [
        { id: a, createdAt: old },
        { id: b, createdAt: old },
      ],
      heldSessionIds: async () => new Set(),
      inFlightSessionIds: () => new Set(),
      isOwned: (id) => isOwnedSteelSessionId(id, marker),
      release: async (id) => {
        if (id === a) throw new Error('steel 500');
        released.push(id);
      },
      now: () => now,
    });
    assert.deepStrictEqual(released, [b]);
    assert.strictEqual(summary.failed, 1);
    assert.strictEqual(summary.released, 1);
  });

  process.stdout.write(`\n${passed} passed\n`);
  if (failures.length > 0) {
    process.stdout.write(`${failures.length} failure(s):\n${failures.join('\n')}\n`);
    process.exit(1);
  }
  process.exit(0);
}

void main();
