/** A unit child that dies natively leaves no output; its signal must reach the runner's report. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { describeChildTermination } from '../../../scripts/unit-test-child-exit';
import { createTestHarness } from './trace-archive-test-utils';

const { test, finish } = createTestHarness('unit test child exit');

function runChild(source: string): Promise<[number | null, NodeJS.Signals | null]> {
  return new Promise((resolveClose, reject) => {
    const child = spawn(process.execPath, ['-e', source], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', (code, signal) => resolveClose([code, signal]));
  });
}

async function main() {
  await test('a real signalled child reports its signal and conventional exit code', async () => {
    const [code, signal] = await runChild("process.kill(process.pid, 'SIGKILL')");
    assert.equal(code, null);
    assert.deepEqual(describeChildTermination(code, signal), {
      exitCode: 128 + constants.signals.SIGKILL,
      label: 'signal SIGKILL',
      signal: 'SIGKILL',
    });
  });

  await test('a real non-zero exit stays distinguishable from a signal', async () => {
    const [code, signal] = await runChild('process.exit(7)');
    assert.deepEqual(describeChildTermination(code, signal), {
      exitCode: 7,
      label: 'exit code 7',
      signal: null,
    });
  });

  await test('a child with neither code nor signal still fails', () => {
    assert.equal(describeChildTermination(null, null).exitCode, 1);
  });

  finish();
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exitCode = 1;
});
