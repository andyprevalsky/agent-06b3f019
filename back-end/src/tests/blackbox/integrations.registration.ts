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
    hash: '732acec1d29b7a134cc1c29e1fb658bb4c052979b68ecde4a03a81a9df727714',
  },
  pooledSequentialTests: {
    count: 34,
    hash: '04776ce085bb4c80590ac063625c7e36be4394dd68dbf8368b96857b62d11183',
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
