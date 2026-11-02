import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import ts from 'typescript';
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

test('UTF-8 fixture output rejects binary and incompatible encoding requests at the type boundary', () => {
  const fixture = join(__dirname, 'processSafety.encoding-contract.ts');
  const source = `
    import type { ExecFileOptions } from 'node:child_process';
    import { execTypeScript } from '../../providers/processSafety';
    type Options = NonNullable<Parameters<typeof execTypeScript>[1]>;
    const defaults: Options = { timeout: 5000 };
    const utf8: Options = { encoding: 'utf8', cwd: '.', env: {} };
    const utfDash: Options = { encoding: 'utf-8' };
    // @ts-expect-error binary output is unsupported
    const binary: Options = { encoding: 'buffer' };
    // @ts-expect-error null requests binary output
    const nullEncoding: Options = { encoding: null };
    // @ts-expect-error non-UTF-8 text is unsupported
    const ascii: Options = { encoding: 'ascii' };
    declare const broad: ExecFileOptions;
    // @ts-expect-error a broad options variable could request an incompatible encoding
    const unchecked: Options = broad;
    declare const output: Awaited<ReturnType<typeof execTypeScript>>;
    const stdout: string = output.stdout;
    const stderr: string = output.stderr;
  `;
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: ['node'],
  };
  const host = ts.createCompilerHost(options);
  const originalRead = host.readFile.bind(host);
  const originalExists = host.fileExists.bind(host);
  host.readFile = (path) => (path === fixture ? source : originalRead(path));
  host.fileExists = (path) => path === fixture || originalExists(path);
  const program = ts.createProgram([fixture], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(
    diagnostics.length,
    0,
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (path) => path,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => '\n',
    })
  );
});
