import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

// Frozen from the pre-split source: exact name/function pairs and phase order.
const expected = {
  parallelTests: {
    count: 231,
    hash: 'bb160b5b525e80277a8009f80f575f0c2e0ab9a1ca9dc9856bbd83a298b665cd',
  },
  sequentialTests: {
    count: 16,
    hash: '5179a4b62d6546997493dd47d3ac7c3856decfd5f5ebd3f4fdb3a7f7f8e7b752',
  },
  pooledSequentialTests: {
    count: 29,
    hash: '5a848853aedf606c378a321025b084a47e59853670b3fb06ee3c0839c2689404',
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
