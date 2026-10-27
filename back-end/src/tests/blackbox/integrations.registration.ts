import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

// Frozen from the pre-split source: exact name/function pairs and phase order.
const expected = {
  parallelTests: {
    count: 230,
    hash: '084d1f78c6f4e40b1f0bbf43738a190299a5684b33f1d934d1e6d48d30aedfb0',
  },
  sequentialTests: {
    count: 15,
    hash: '9a54f0196e090a01a014a894f2f4d21c6ee027872385276113c927ea3d9770f7',
  },
  pooledSequentialTests: {
    count: 34,
    hash: '969d66efa40349cb9fbf62df916a0f5cd59322c00efe22c0f94c6333dcae6881',
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
