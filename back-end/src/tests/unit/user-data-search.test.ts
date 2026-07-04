#!/usr/bin/env tsx
/* eslint-disable no-console */

import assert from 'node:assert';
import {
  executeUserDataGrep,
  registerUserDataGrep,
  type UserDataGrepResult,
} from '../../providers/userDataSearch';

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`  ❌ ${name}`);
  }
}

async function main(): Promise<void> {
  await test('throws before grep executor registration', async () => {
    await assert.rejects(
      executeUserDataGrep('user-1', { pattern: 'jane' }),
      /user data grep not initialized/
    );
  });

  await test('delegates to registered grep executor', async () => {
    const expected: UserDataGrepResult = {
      matches: [
        {
          source: 'network',
          path: 'people/jane',
          pointer: 'person:jane',
          timestamp: '2026-07-03T00:00:00.000Z',
          content: 'Jane email jane@example.com',
        },
      ],
      total_matches: 1,
      truncated: false,
      pattern: 'jane',
      sources: ['network'],
      applied_limit: 20,
      applied_offset: 0,
    };
    registerUserDataGrep(async (userId, params) => {
      assert.strictEqual(userId, 'user-1');
      assert.deepStrictEqual(params, { pattern: 'jane', source: 'network' });
      return expected;
    });

    const actual = await executeUserDataGrep('user-1', { pattern: 'jane', source: 'network' });
    assert.deepStrictEqual(actual, expected);
  });
}

void main().then(() => {
  if (failures.length > 0) {
    console.error('\nFailures:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(`\n${passed}/2 user-data-search tests passed`);
});
