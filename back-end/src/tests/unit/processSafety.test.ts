import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execTypeScript } from '../../providers/processSafety';

test('TypeScript fixtures directly own their interpreter process', async () => {
  const owned = await execTypeScript(['-e', 'console.log(process.ppid)'], { timeout: 5000 });
  assert.equal(
    Number(owned.stdout.trim()),
    process.pid,
    'the fixture owner must launch the TypeScript interpreter directly, without a launcher process'
  );
});

test('TypeScript fixture failures retain exit and output evidence', async () => {
  await assert.rejects(
    execTypeScript(
      [
        '-e',
        'console.log("fixture stdout"); console.error("fixture stderr"); process.exitCode = 23',
      ],
      { timeout: 5000 }
    ),
    (error: unknown) => {
      assert(error instanceof Error);
      assert.match(error.message, /code=23/);
      assert.match(error.message, /signal=none/);
      assert.match(error.message, /killed=false/);
      assert.match(error.message, /fixture stdout/);
      assert.match(error.message, /fixture stderr/);
      return true;
    }
  );
});

test('a startup timeout retains killed and signal evidence without child output', async () => {
  await assert.rejects(
    execTypeScript(['-e', 'setInterval(() => {}, 1000)'], { timeout: 1 }),
    (error: unknown) => {
      assert(error instanceof Error);
      assert.match(error.message, /signal=SIGTERM/);
      assert.match(error.message, /killed=true/);
      assert.match(error.message, /stdout:/);
      assert.match(error.message, /stderr:/);
      return true;
    }
  );
});
