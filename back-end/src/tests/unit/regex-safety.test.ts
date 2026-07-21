import assert from 'node:assert/strict';

import { checkPatternSafety } from '../../domains/data/regexSafety';

const analyzerFailure = checkPatternSafety('safe-looking-pattern', '', () => {
  throw new Error('analyzer unavailable');
});

assert.deepEqual(analyzerFailure, {
  ok: false,
  reason: 'Pattern could not be verified as safe to evaluate.',
});

process.stdout.write('Regex analyzer failures are rejected\n');
