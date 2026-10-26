import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

// Frozen from the pre-split source: exact name/function pairs and phase order.
const expected = {
  parallelTests: {
    count: 230,
    hash: '084d1f78c6f4e40b1f0bbf43738a190299a5684b33f1d934d1e6d48d30aedfb0',
  },
  sequentialTests: {
    count: 12,
    hash: 'ecca48607c6cceb9b92b1ec0b49d5f89d5b8399b7f536fc91fb571945ac82059',
  },
  pooledSequentialTests: {
    count: 29,
    hash: 'e93a5afc4cdf6c8eccdfe0624a3b4a2a8169db906e407ff81b7b72c321ea3d2d',
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
