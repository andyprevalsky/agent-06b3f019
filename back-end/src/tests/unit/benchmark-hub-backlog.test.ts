import assert from 'node:assert/strict';
import test from 'node:test';
import { putBoundary, deferred } from './benchmark-hub-admission.testkit';

test('burst of 40 tiny independent uploads shares catalog work after a held writer', async () => {
  const entered = deferred();
  const release = deferred();
  let catalogWrites = 0;
  const boundary = putBoundary(async (key) => {
    if (key === 'runs/held.json') {
      entered.resolve();
      await release.promise;
    }
    if (key === 'index.json') catalogWrites++;
  });
  const holder = boundary.putRun({ run_id: 'held', tasks: [] }, { live: false });
  await entered.promise;
  const uploads = Array.from({ length: 40 }, (_, i) =>
    boundary.putRun({ run_id: `cancelled-${i}`, tasks: [] }, { live: false })
  );
  release.resolve();
  await Promise.all([holder, ...uploads]);
  assert.equal(boundary.runWrites().length, 41, 'every distinct bundle remains persisted');
  assert.ok(
    catalogWrites <= 2,
    `serial catalog amplification: expected <=2 rounds, observed ${catalogWrites}`
  );
});

test('SQL commit rejection never acknowledges staged objects or updates caches', async () => {
  const marker = new Error('SQL commit refused after object writes');
  let fail = true;
  const boundary = putBoundary(
    async () => {},
    async () => {
      if (fail) throw marker;
    }
  );
  await assert.rejects(
    boundary.putRun({ run_id: 'commit-refusal', tasks: [] }),
    (error) => error === marker
  );
  assert.equal(boundary.runWrites().length, 1, 'remote staging is not claimed to roll back');
  assert.equal(boundary.stats().cacheUpdates, 0);
  assert.equal(boundary.stats().ancestors, 0);
  fail = false;
  await boundary.putRun({ run_id: 'commit-refusal', tasks: [] });
  assert.equal(boundary.stats().cacheUpdates, 1);
  assert.equal(boundary.stats().ancestors, 1);
});
