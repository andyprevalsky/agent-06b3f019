/** Cold-load the public browser lifecycle entrypoints without native or DB effects. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

export async function runBrowserColdImportCases(): Promise<void> {
  const entries = [
    ['../../providers/browser/kernel', 'releaseKernelRemoteSession'],
    ['../../domains/compute-grants/connectSession', 'startConnectSession'],
    ['../../domains/compute-grants/connectSession.watcher', 'startSignInWatcher'],
  ] as const;
  for (const [entry, exported] of entries) {
    // Each process starts with an empty module cache; a warm import hides cycles.
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '-e',
        `const assert = require('node:assert/strict');
let networkAttempts = 0;
const denyNetwork = () => { networkAttempts++; throw new Error('cold import attempted network I/O'); };
require('node:net').Socket.prototype.connect = denyNetwork;
globalThis.fetch = denyNetwork;
const loaded = require(process.argv[1]);
assert.equal(typeof loaded[process.argv[2]], 'function');
assert.equal(networkAttempts, 0, 'cold import attempted network I/O');`,
        require.resolve(entry),
        exported,
      ],
      { encoding: 'utf8', timeout: 60_000 }
    );
    assert.ifError(result.error);
    assert.equal(
      result.status,
      0,
      `${entry} cold import failed:\n${result.stdout}${result.stderr}`
    );
  }
  console.log('PASS browser lifecycle cold imports (3 isolated entrypoints, no network I/O)');
}
