#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { storableMessageParams, withoutNulJson } from '../../providers/messageParams';

const NUL = String.fromCharCode(0);

// NUL is removed from strings and keys at every depth.
assert.deepEqual(withoutNulJson({ [`ti${NUL}tle`]: `a${NUL}b`, nested: [{ k: `${NUL}x` }] }), {
  title: 'ab',
  nested: [{ k: 'x' }],
});

// A sanitized key never overwrites a key that was already clean, in either order.
for (const metadata of [
  { toolCallId: 'canonical', [`toolCallId${NUL}`]: 'shadow' },
  { [`toolCallId${NUL}`]: 'shadow', toolCallId: 'canonical' },
]) {
  const stored = storableMessageParams({ text: 't', metadata });
  assert.deepEqual(stored.metadata, { toolCallId: 'canonical' });
}

// Two NUL-bearing keys that sanitize alike keep the first one deterministically.
assert.deepEqual(withoutNulJson({ [`a${NUL}`]: 1, [`${NUL}a`]: 2 }), { a: 1 });
process.stdout.write('message params NUL keys: PASS\n');
