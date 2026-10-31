import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

// Frozen from the pre-split source: exact name/function pairs and phase order.
const expected = {
  parallelTests: {
    count: 231,
    hash: 'bb160b5b525e80277a8009f80f575f0c2e0ab9a1ca9dc9856bbd83a298b665cd',
  },
  sequentialTests: {
    count: 17,
    hash: '8b1f3584d289c31a81def8b5ab119b80392865750697e8ee5d35a3b78d479384',
  },
  pooledSequentialTests: {
    count: 35,
    hash: '0f62ef2f07e93f703e1e6a47e807c77f3298e2c137a06b08489003c57418ddd0',
  },
  boundarySequentialTests: {
    count: 7,
    hash: '2ba0663c568b870dbc8c103221ad75105c9c205e8ba50a8a4cc494ae92996c0d',
  },
};

export function assertIntegrationRegistration(
  group: keyof typeof expected,
  tests: { name: string; fn: () => Promise<void> }[]
) {
  const pairs = tests.map((test) => ({ name: JSON.stringify(test.name), fn: test.fn.name }));
  assert.equal(tests.length, expected[group].count, group + ' count changed');
  assert.equal(
    createHash('sha256').update(JSON.stringify(pairs)).digest('hex'),
    expected[group].hash,
    group + ' names, functions or order changed'
  );
}
