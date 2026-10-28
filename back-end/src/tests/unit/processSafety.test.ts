import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execTypeScript, typeScriptProcess } from '../../providers/processSafety';

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

test('TypeScript preload supports every declared Node generation and file URL encoding', () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'node')!;
  try {
    for (const [version, flag] of [
      ['18.0.0', '--loader'],
      ['18.17.0', '--loader'],
      ['18.18.0', '--loader'],
      ['18.19.0', '--import'],
      ['20.0.0', '--loader'],
      ['20.6.0', '--import'],
      ['22.0.0', '--import'],
    ]) {
      Object.defineProperty(process.versions, 'node', { ...descriptor, value: version });
      const [command, argv] = typeScriptProcess(['-e', 'void 0']);
      assert.equal(command, process.execPath);
      assert.equal(argv[0], flag, version);
      assert.equal(new URL(argv[1]).protocol, 'file:');
      assert.deepEqual(
        argv.slice(2),
        flag === '--loader'
          ? ['--require', require.resolve('tsx/cjs'), '-e', 'void 0']
          : ['-e', 'void 0']
      );
    }
  } finally {
    Object.defineProperty(process.versions, 'node', descriptor);
  }
});
