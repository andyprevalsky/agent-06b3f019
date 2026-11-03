/** Native rotation acknowledgements must keep the worker browser and allocation provenance. */
import assert from 'node:assert/strict';
import type { FakeTilionServer } from './tilion-fake-server.support';

type Tilion = typeof import('../../providers/browser/tilion');

interface RotationContext {
  tilion: Pick<Tilion, 'rotateTilionSession' | 'TilionUncarriedStateError'>;
  sessionId: string;
  rows: ReadonlyMap<string, Record<string, unknown>>;
  live: ReadonlySet<string>;
  rotateReplies: Array<{ status: number; body: unknown }>;
  server: FakeTilionServer;
  getCdpConnects: () => number;
  restored: { cookies: unknown[] };
  replaceWithWorkerState: () => Promise<Awaited<ReturnType<Tilion['rotateTilionSession']>>>;
}

export async function assertTilionRotationAcknowledgements({
  tilion,
  sessionId,
  rows,
  live,
  rotateReplies,
  server,
  getCdpConnects,
  restored,
  replaceWithWorkerState,
}: RotationContext): Promise<string> {
  // ── G2: residential rotate-ip in place when Tilion allocates a fresh exit ──
  rotateReplies.push({
    status: 200,
    body: {
      session_id: sessionId,
      rotated: true,
      region: 'us-east-1',
      fresh_allocation: true,
    },
  });
  const inPlace = await tilion.rotateTilionSession('task-a', 'residential');
  assert.equal(inPlace.sessionId, sessionId);
  assert.equal(inPlace.previousSessionId, sessionId, 'in place: caller must not release');
  assert.deepEqual(inPlace.ipRotation, {
    rotated: true,
    freshAllocation: true,
    region: 'us-east-1',
  });
  assert.equal(rows.get('task-a')?.proxyTier, 'residential');
  assert.equal(rows.get('task-a')?.kernelProxySource, 'tilion_residential_rotated_us-east-1');
  assert.equal(live.has(sessionId), true, 'in-place rotation keeps the session');

  // The captured native response acknowledges movement to another pooled IP;
  // fresh_allocation describes allocation provenance, not whether it rotated.
  const createsBeforePoolRotation = server.callsTo('POST', /^\/v1\/session$/).length;
  const connectsBeforePoolRotation = getCdpConnects();
  rotateReplies.push({
    status: 200,
    body: {
      session_id: sessionId,
      rotated: true,
      region: 'us-east-1',
      fresh_allocation: false,
    },
  });
  const pooled = await tilion.rotateTilionSession('task-a', 'residential');
  assert.equal(pooled.sessionId, sessionId);
  assert.equal(pooled.previousSessionId, sessionId);
  assert.deepEqual(pooled.ipRotation, {
    rotated: true,
    freshAllocation: false,
    region: 'us-east-1',
  });
  assert.equal(server.callsTo('POST', /^\/v1\/session$/).length, createsBeforePoolRotation);
  assert.equal(
    getCdpConnects(),
    connectsBeforePoolRotation,
    'rotation must not take the worker CDP slot'
  );
  assert.equal(live.has(sessionId), true);

  for (const invalidReply of [
    { session_id: sessionId, rotated: true },
    { session_id: sessionId, rotated: true, fresh_allocation: 'false' },
    { session_id: 'unrelated-session', rotated: true, fresh_allocation: false },
    { rotated: true, fresh_allocation: false },
  ]) {
    rotateReplies.push({ status: 200, body: invalidReply });
    await assert.rejects(
      tilion.rotateTilionSession('task-a', 'residential'),
      tilion.TilionUncarriedStateError
    );
    assert.equal(rows.get('task-a')?.sessionId, sessionId);
    assert.equal(live.has(sessionId), true);
  }

  // An explicitly unacknowledged rotation still requires the worker's state.
  rotateReplies.push({
    status: 200,
    body: {
      session_id: sessionId,
      rotated: false,
      region: 'us-east-1',
      fresh_allocation: false,
    },
  });
  restored.cookies.length = 0;
  const unproven = await replaceWithWorkerState();
  assert.notEqual(unproven.sessionId, sessionId, 'stale exit must fall back to replacement');
  assert.equal(unproven.previousSessionId, sessionId);
  assert.equal(unproven.ipRotation, undefined);
  assert.equal((restored.cookies[0] as { value: string }).value, 'worker-2');
  assert.equal(server.callsTo('POST', /\/rotate-ip$/).length, 8);
  return unproven.sessionId;
}
