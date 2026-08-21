#!/usr/bin/env tsx
import assert from 'node:assert';
import { recoveryOriginStorageScript } from '../../providers/browser/recoveryOriginStorage';

const script = recoveryOriginStorageScript({
  origins: [
    {
      origin: 'https://checkout.example',
      localStorage: [{ name: 'k', value: 'v' }],
      indexedDB: [{ name: 'db', version: 1, stores: [] }],
    },
  ],
});

assert.match(script, /let localStorageRestored = false/);
assert.match(script, /localStorageRestored = true/);
assert.match(script, /const finish = \(ok\) =>/);
assert.match(script, /if \(!ok\) restoredAllDatabases = false/);
assert.match(script, /setTimeout\(\(\) => finish\(false\)/);
assert.match(script, /finish\(false\)/);
assert.match(
  script,
  /transaction\.oncomplete = \(\) => \{ db\.close\(\); clearTimeout\(timer\); finish\(true\); \}/
);
assert.match(
  script,
  /transaction\.onerror = \(\) => \{ try \{ db\.close\(\); \} catch \{\} clearTimeout\(timer\); finish\(false\); \}/
);
assert.match(
  script,
  /transaction\.onabort = \(\) => \{ try \{ db\.close\(\); \} catch \{\} clearTimeout\(timer\); finish\(false\); \}/
);
assert.match(
  script,
  /if \(localStorageRestored && restoredAllDatabases\) \{\s*try \{ sessionStorage\.setItem\(completionKey, '1'\); \} catch \{\}\s*\}/
);

process.stdout.write('recovery-origin-storage completion gating tests passed\n');
