/** The shipped CLI forwards argv intact, preserves failures and never retries writes. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { resolve, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const cli = resolve(__dirname, '../../assets/rose-tools/rose.cjs');

test('template CLI run preserves argv, bearer auth and the remote exit code', async () => {
  let body: unknown;
  const server = createServer(async (req, res) => {
    assert.equal(req.url, '/cli/fixture/run');
    assert.equal(req.headers.authorization, 'Bearer fixture-token');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    body = JSON.parse(raw);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ exit_code: 7, stdout: '', stderr: 'not connected' }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const args = ['search', 'a query with spaces', '$(must stay literal)', '--json'];
  try {
    await assert.rejects(
      exec(process.execPath, [cli, 'cli', 'run', 'fixture', '--', ...args], {
        env: {
          ...process.env,
          ROSE_TOOLS_URL: `http://127.0.0.1:${address.port}`,
          ROSE_TOOLS_TOKEN: 'fixture-token',
        },
      }),
      (error: unknown) => {
        const result = error as { code: number; stdout: string };
        assert.equal(result.code, 7);
        assert.equal(JSON.parse(result.stdout).stderr, 'not connected');
        return true;
      }
    );
    const parsed = body as { args: string[]; request_id: string };
    assert.deepEqual(parsed.args, args);
    assert.match(parsed.request_id, /^[0-9a-f-]{36}$/);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test('an uncertain command response is surfaced without executing it twice', async () => {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'template unavailable' }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await assert.rejects(
      exec(process.execPath, [cli, 'cli', 'run', 'fixture', '--', 'write'], {
        env: {
          ...process.env,
          ROSE_TOOLS_URL: `http://127.0.0.1:${address.port}`,
          ROSE_TOOLS_TOKEN: 'fixture-token',
        },
      })
    );
    assert.deepEqual(calls, ['POST /cli/fixture/run']);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test('publish requires JSON verification argv before calling the backend', async () => {
  await assert.rejects(
    exec(process.execPath, [cli, 'cli', 'publish', 'fixture', '--verify', 'not-json']),
    (error: unknown) => {
      assert.match((error as { stderr: string }).stderr, /--verify must be a JSON argv array/);
      return true;
    }
  );
});

test('publish forwards reproducible installation and credential metadata', async () => {
  let body: unknown;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    body = JSON.parse(raw);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'connected' }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await exec(
      process.execPath,
      [
        cli,
        'cli',
        'publish',
        'fixture',
        '--name',
        'YC',
        '--command',
        '/usr/local/bin/yc',
        '--verify',
        '["me"]',
        '--install-script',
        'install-yc',
        '--install-verify',
        '["--version"]',
        '--credential-files',
        '[".yc/credentials.json"]',
      ],
      {
        env: {
          ...process.env,
          ROSE_TOOLS_URL: `http://127.0.0.1:${address.port}`,
          ROSE_TOOLS_TOKEN: 'fixture-token',
        },
      }
    );
    assert.deepEqual(body, {
      name: 'YC',
      command: '/usr/local/bin/yc',
      verify: ['me'],
      install: 'install-yc',
      install_verify: ['--version'],
      credential_files: ['.yc/credentials.json'],
    });
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

import { mkdtemp, mkdir, writeFile, readFile, stat, rm, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';

async function nativeFixture(
  options: {
    original?: boolean;
    releaseFails?: boolean;
    unsafe?: boolean;
    heartbeatFails?: boolean;
    missingCredential?: boolean;
    heartbeatRace?: boolean;
  } = {}
) {
  const home = await mkdtemp(join(tmpdir(), 'rose-native-cli-'));
  const work = join(home, 'project');
  const authDir = join(home, '.yc');
  await mkdir(work);
  await mkdir(authDir);
  const auth = join(authDir, 'credentials.json');
  if (options.original) {
    await writeFile(auth, 'previous', { mode: 0o640 });
    await chmod(auth, 0o640);
  }
  if (options.unsafe) await symlink(work, join(home, 'redirect'));
  const script = join(home, 'command.cjs');
  await writeFile(
    script,
    `const fs = require('fs'); const path = require('path');
    const file = path.join(process.env.HOME, '.yc/credentials.json');
    console.log(JSON.stringify({cwd:process.cwd(), args:process.argv.slice(2), session:process.env.YC_CLI_SESSION, mode:fs.existsSync(file) ? fs.statSync(file).mode & 511 : null}));
    ${options.missingCredential ? '' : "fs.writeFileSync(file, 'rotated');"}
    ${options.heartbeatRace ? 'setTimeout(() => process.exit(0), 20_150);' : options.heartbeatFails ? 'setInterval(() => {}, 1000);' : 'process.exitCode = 7;'}
  `
  );
  const requests: Array<{ path: string; body: unknown }> = [];
  let heartbeatPending = false;
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/cli/fixture/native/')) {
      res.statusCode = 404;
      res.end();
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ path: req.url || '', body: raw ? JSON.parse(raw) : {} });
    assert.equal(req.headers.authorization, 'Bearer fixture-token');
    res.setHeader('Content-Type', 'application/json');
    if (req.url?.endsWith('/acquire'))
      res.end(
        JSON.stringify({
          lease_token: 'private-lease',
          command: process.execPath,
          files: [
            {
              path: options.unsafe ? 'redirect/credentials.json' : '.yc/credentials.json',
              data: options.missingCredential ? null : Buffer.from('initial').toString('base64'),
            },
          ],
        })
      );
    else if (
      (req.url?.endsWith('/release') && options.releaseFails) ||
      (req.url?.endsWith('/heartbeat') && options.heartbeatFails)
    ) {
      res.statusCode = 503;
      res.end(JSON.stringify({ error: 'private-lease must never print' }));
    } else if (req.url?.endsWith('/heartbeat') && options.heartbeatRace) {
      heartbeatPending = true;
      setTimeout(() => {
        heartbeatPending = false;
        res.end('{}');
      }, 300);
    } else if (req.url?.endsWith('/release') && heartbeatPending) {
      res.statusCode = 409;
      res.end(JSON.stringify({ error: 'heartbeat still writing' }));
    } else res.end('{}');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    home,
    work,
    auth,
    script,
    requests,
    env: {
      ...process.env,
      HOME: home,
      ROSE_AGENT_ID: 'task-fixture',
      ROSE_TOOLS_URL: `http://127.0.0.1:${address.port}`,
      ROSE_TOOLS_TOKEN: 'fixture-token',
    },
    cleanup: async () => {
      await new Promise<void>((done) => server.close(() => done()));
      await rm(home, { recursive: true, force: true });
    },
  };
}

for (const original of [false, true]) {
  test(`native CLI keeps local cwd/argv, captures rotated auth and restores original=${original}`, async () => {
    const fixture = await nativeFixture({ original });
    try {
      await assert.rejects(
        exec(
          process.execPath,
          [cli, 'cli', 'native', 'fixture', '--', fixture.script, 'a b', '$(literal)'],
          { cwd: fixture.work, env: fixture.env }
        ),
        (error: unknown) => {
          const result = error as { code: number; stdout: string; stderr: string };
          assert.equal(result.code, 7);
          assert.deepEqual(JSON.parse(result.stdout), {
            cwd: fixture.work,
            args: ['a b', '$(literal)'],
            session: 'task-fixture',
            mode: 0o600,
          });
          assert.ok(!`${result.stdout}${result.stderr}`.includes('private-lease'));
          return true;
        }
      );
      assert.deepEqual(
        fixture.requests.map((request) => request.path),
        ['/cli/fixture/native/acquire', '/cli/fixture/native/release']
      );
      assert.deepEqual(fixture.requests[1].body, {
        lease_token: 'private-lease',
        files: [{ path: '.yc/credentials.json', data: Buffer.from('rotated').toString('base64') }],
      });
      if (original) {
        assert.equal(await readFile(fixture.auth, 'utf8'), 'previous');
        assert.equal((await stat(fixture.auth)).mode & 0o777, 0o640);
      } else await assert.rejects(stat(fixture.auth), { code: 'ENOENT' });
    } finally {
      await fixture.cleanup();
    }
  });
}

test('native release failure is not retried and still restores local authentication', async () => {
  const fixture = await nativeFixture({ original: true, releaseFails: true });
  try {
    await assert.rejects(
      exec(process.execPath, [cli, 'cli', 'native', 'fixture', '--', fixture.script], {
        cwd: fixture.work,
        env: fixture.env,
      }),
      (error: unknown) => {
        assert.match((error as { stderr: string }).stderr, /release failed/);
        assert.ok(!(error as { stderr: string }).stderr.includes('private-lease'));
        return true;
      }
    );
    assert.equal(fixture.requests.filter((request) => request.path.endsWith('/release')).length, 1);
    assert.equal(await readFile(fixture.auth, 'utf8'), 'previous');
  } finally {
    await fixture.cleanup();
  }
});

test('native credentials reject symlink parents before launching the command', async () => {
  const fixture = await nativeFixture({ unsafe: true });
  try {
    await assert.rejects(
      exec(process.execPath, [cli, 'cli', 'native', 'fixture', '--', fixture.script], {
        cwd: fixture.work,
        env: fixture.env,
      }),
      (error: unknown) => {
        assert.match((error as { stderr: string }).stderr, /Unsafe native CLI credential path/);
        assert.equal((error as { stdout: string }).stdout, '');
        return true;
      }
    );
    await assert.rejects(stat(join(fixture.work, 'credentials.json')), { code: 'ENOENT' });
  } finally {
    await fixture.cleanup();
  }
});

test(
  'native heartbeat loss stops the owned command and removes borrowed auth',
  { timeout: 35000 },
  async () => {
    const fixture = await nativeFixture({ heartbeatFails: true });
    try {
      await assert.rejects(
        exec(process.execPath, [cli, 'cli', 'native', 'fixture', '--', fixture.script], {
          cwd: fixture.work,
          env: fixture.env,
        }),
        (error: unknown) => {
          assert.match((error as { stderr: string }).stderr, /lost its credential lease/);
          return true;
        }
      );
      assert.equal(
        fixture.requests.filter((request) => request.path.endsWith('/heartbeat')).length,
        1
      );
      await assert.rejects(stat(fixture.auth), { code: 'ENOENT' });
    } finally {
      await fixture.cleanup();
    }
  }
);

test('native logged-out credentials remove stale local auth during execution and restore it afterward', async () => {
  const fixture = await nativeFixture({ original: true, missingCredential: true });
  try {
    await assert.rejects(
      exec(process.execPath, [cli, 'cli', 'native', 'fixture', '--', fixture.script], {
        cwd: fixture.work,
        env: fixture.env,
      }),
      (error: unknown) => {
        assert.equal(JSON.parse((error as { stdout: string }).stdout).mode, null);
        return true;
      }
    );
    assert.deepEqual(fixture.requests[1].body, {
      lease_token: 'private-lease',
      files: [{ path: '.yc/credentials.json', data: null }],
    });
    assert.equal(await readFile(fixture.auth, 'utf8'), 'previous');
    assert.equal((await stat(fixture.auth)).mode & 0o777, 0o640);
  } finally {
    await fixture.cleanup();
  }
});

test(
  'native release waits for an in-flight heartbeat before saving refreshed credentials',
  { timeout: 35000 },
  async () => {
    const fixture = await nativeFixture({ heartbeatRace: true });
    try {
      await exec(process.execPath, [cli, 'cli', 'native', 'fixture', '--', fixture.script], {
        cwd: fixture.work,
        env: fixture.env,
      });
      assert.deepEqual(
        fixture.requests.map((request) => request.path),
        [
          '/cli/fixture/native/acquire',
          '/cli/fixture/native/heartbeat',
          '/cli/fixture/native/release',
        ]
      );
      await assert.rejects(stat(fixture.auth), { code: 'ENOENT' });
    } finally {
      await fixture.cleanup();
    }
  }
);
