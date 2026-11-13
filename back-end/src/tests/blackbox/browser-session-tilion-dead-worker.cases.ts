/** Dead Tilion worker at browser init (2026-11-13 sess_993d70*): see the fixture header. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export async function runTilionDeadWorkerInitCases(): Promise<void> {
  // Own process: provider env is read at import and auth lookup is module-mocked.
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--experimental-test-module-mocks',
      '--import',
      'tsx',
      'src/tests/blackbox/browser-session-tilion-dead-worker.fixture.ts',
    ],
    { env: process.env, maxBuffer: 20_000_000 }
  );
  assert.match(stdout, /PASS Tilion dead worker/);
  console.log(stdout.split('\n').find((line) => line.startsWith('PASS Tilion dead worker')));
}
