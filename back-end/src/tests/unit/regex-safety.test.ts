#!/usr/bin/env tsx

import assert from 'node:assert';
import { checkPatternSafety } from '../../domains/data/regexSafety';

const result = checkPatternSafety('safe-looking-pattern', '', () => {
  throw new Error('simulated analyzer timeout');
});

assert.deepStrictEqual(result, {
  ok: false,
  reason:
    'Pattern safety analysis did not complete. Use a simpler expression without nested quantifiers or stacked wildcards.',
});

process.stdout.write('PASS regex safety fails closed when analysis throws or times out\n');
