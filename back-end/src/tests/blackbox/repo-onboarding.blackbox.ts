/** Real CLI and encrypted HTTP boundary; no paid providers. */
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { generateKeyPairSync, privateDecrypt, constants, createDecipheriv } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { after, test } from 'node:test';
const run = promisify(execFile);
const root = mkdtempSync(join(tmpdir(), 'rose-onboarding-'));
const cli = process.env.ROSE_SYNC_TEST_CLI ?? resolve('../scripts/rose-sync');
const secret = 'onboarding-private-fixture-value';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
after(() => rmSync(root, { recursive: true, force: true }));
function fixture(label: string, remote = 'https://github.com/example/app.git') {
  const dir = join(root, label);
  mkdirSync(dir);
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: dir });
  writeFileSync(join(dir, '.gitignore'), '.env\n');
  writeFileSync(join(dir, 'package.json'), '{"name":"fixture","version":"1.0.0"}');
  writeFileSync(
    join(dir, 'package-lock.json'),
    '{"name":"fixture","lockfileVersion":3,"packages":{}}'
  );
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'add', '.'], {
    cwd: dir,
  });
  execFileSync(
    'git',
    ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture'],
    { cwd: dir }
  );
  const env = join(root, `${label}.env`);
  writeFileSync(env, `APP_KEY=${secret}\n`);
  symlinkSync(env, join(dir, '.env'));
  return dir;
}
function decrypt(encoded: string): string {
  const e = JSON.parse(Buffer.from(encoded, 'base64').toString());
  const key = privateDecrypt(
    { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(e.encrypted_aes_key, 'base64')
  );
  const bytes = Buffer.from(e.ciphertext, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'base64'));
  decipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]).toString();
}
async function withApi<T>(
  options: { missing?: boolean; mismatch?: boolean },
  fn: (api: string, pushes: () => number, lastPost: () => string) => Promise<T>
) {
  let pushed = 0;
  let lastPost = '';
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString();
    assert(!raw.includes(secret), 'HTTP request does not expose a plaintext key');
    const project = {
      id: 'fixture-project',
      name: 'Fixture',
      repoUrl: options.mismatch
        ? 'https://github.com/another/repo.git'
        : 'https://github.com/example/app.git',
    };
    let body: unknown = project;
    if (req.url === '/api/projects/sync-key')
      body = { keyId: 'test-key', publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) };
    else if (req.url?.endsWith('/env-files'))
      body = {
        envFiles: options.missing
          ? [{ path: 'missing/.env', hasContent: false }]
          : pushed
            ? [{ path: '.env', hasContent: true }]
            : [],
      };
    else if (req.url?.endsWith('/sync') && req.method === 'GET')
      body = { revision: 0, salt: 'fixture-salt', files: [] };
    else if (req.url?.endsWith('/sync')) {
      pushed++;
      lastPost = raw;
      const input = JSON.parse(raw);
      const file = input.files.find((f: { path: string }) => f.path === '.env');
      assert.equal(decrypt(file.encryptedContent), `APP_KEY=${secret}\n`);
      assert.deepEqual(input.manifest.setup.commands, ["(cd '.' && npm ci)"]);
      body = { project, revision: 1, written: ['.env'], unchanged: [], deleted: [] };
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  assert(address && typeof address === 'object');
  try {
    return await fn(
      `http://127.0.0.1:${address.port}`,
      () => pushed,
      () => lastPost
    );
  } finally {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  }
}
function command(dir: string, api: string) {
  return run(
    process.execPath,
    [cli, 'onboard', '--dir', dir, '--project', 'Fixture', '--api', api, '--json'],
    { env: { ...process.env, ROSE_TOKEN: '', ROSE_API_KEY: 'personal-api-key', ROSE_USER_ID: '' } }
  );
}
test('onboard imports linked real keys encrypted and configures locked dependencies', async () => {
  await withApi({}, async (api, pushes) => {
    const result = await command(fixture('success'), api);
    const body = JSON.parse(result.stdout);
    assert.equal(pushes(), 1);
    assert.equal(body.onboarding.status, 'configured');
    assert.match(body.onboarding.verification, /not been verified/);
    assert(!result.stdout.includes(secret));
    assert(!result.stderr.includes(secret));
  });
});
test('onboard blocks missing declared files before uploading a partial environment', async () => {
  await withApi({ missing: true }, async (api, pushes) => {
    await assert.rejects(command(fixture('missing'), api), /missing\/\.env/);
    assert.equal(pushes(), 0);
  });
});
test('onboard refuses to send keys to a different repository project', async () => {
  await withApi({ mismatch: true }, async (api, pushes) => {
    await assert.rejects(command(fixture('mismatch'), api), /does not match/);
    assert.equal(pushes(), 0);
  });
});
test('Rose onboarding requires all six real environment files, never templates', async () => {
  const dir = fixture('rose', 'https://github.com/Rose-Ai-Labs/rose.git');
  await assert.rejects(command(dir, 'http://127.0.0.1:1'), /Import the real files: agents\/\.env/);
});
test('onboarded workspace restores keys and runs dependency setup', async () => {
  const { config } = await import('dotenv');
  config();
  const {
    restoreWorkspace,
    runProjectStartup,
    registerWorkspaceExecutor,
    unregisterWorkspaceExecutor,
    localWorkspaceExecutor,
  } = await import('../../providers/projects/workspace');
  await withApi({}, async (api, _pushes, lastPost) => {
    const dir = fixture('restore');
    const pkg = {
      name: 'fixture',
      version: '1.0.0',
      scripts: { postinstall: `node -e "require('fs').writeFileSync('deps-ready.txt','ready')"` },
    };
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
    writeFileSync(
      join(dir, 'package-lock.json'),
      JSON.stringify({
        name: 'fixture',
        version: '1.0.0',
        lockfileVersion: 3,
        packages: { '': { name: 'fixture', version: '1.0.0', hasInstallScript: true } },
      })
    );
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'add', '.'], {
      cwd: dir,
    });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'setup'],
      { cwd: dir }
    );
    await command(dir, api);
    const post = JSON.parse(lastPost());
    const home = join(root, 'restored');
    mkdirSync(home);
    const id = 'onboarding-runtime';
    registerWorkspaceExecutor(
      id,
      localWorkspaceExecutor(home, {
        ...process.env,
        npm_config_cache: join(root, 'npm-cache'),
        npm_config_audit: 'false',
        npm_config_fund: 'false',
      })
    );
    try {
      await restoreWorkspace(id, {
        project: {
          id: 'project',
          name: 'Fixture',
          repoUrl: dir,
          defaultBranch: 'main',
          startupScript: null,
          startupTimeoutS: 60,
        },
        revision: 1,
        manifest: post.manifest,
        files: post.files.map(
          (file: {
            path: string;
            kind: 'env' | 'config';
            encryptedContent: string;
            linkTarget: string | null;
          }) => ({
            path: file.path,
            kind: file.kind,
            content: Buffer.from(decrypt(file.encryptedContent)),
            linkTarget: file.linkTarget,
          })
        ),
        gitBundle: post.gitBundle ? Buffer.from(decrypt(post.gitBundle.encrypted), 'base64') : null,
        uncommittedPatch: post.uncommittedPatch
          ? Buffer.from(decrypt(post.uncommittedPatch.encrypted), 'base64')
          : null,
        redactions: [secret],
      });
      const result = await runProjectStartup(id);
      assert.equal(result.status, 'ok', result.outputTail);
      assert.equal(readFileSync(join(home, 'workspace', '.env'), 'utf8'), `APP_KEY=${secret}\n`);
      assert.equal(statSync(join(home, 'workspace', '.env')).mode & 0o777, 0o600);
      assert.equal(readFileSync(join(home, 'workspace', 'deps-ready.txt'), 'utf8'), 'ready');
      assert(!JSON.stringify(result).includes(secret));
    } finally {
      unregisterWorkspaceExecutor(id);
    }
  });
});

// ── `rose agent-init --login-code` (Set up with your coding agent) ──
const LOGIN_CODE = `rlc_${'a'.repeat(32)}`;
const CREDENTIAL = `rose_cli_${'c'.repeat(43)}`;
async function withLoginApi<T>(
  fn: (api: string, seen: () => string[]) => Promise<T>,
  options: { exchangeBody?: string } = {}
) {
  const seen: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    // The boxes.dev daemon probes every new local listener with `HEAD /`; it is
    // not a CLI request.
    if (req.method === 'HEAD' && req.url === '/') {
      res.end();
      return;
    }
    seen.push(`${req.method} ${req.url} ${req.headers.authorization ?? ''}`);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/projects/cli-login-codes/exchange') {
      const { code } = JSON.parse(Buffer.concat(chunks).toString()) as { code: string };
      if (code !== LOGIN_CODE) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'This login code is invalid, expired or already used.' }));
        return;
      }
      if (options.exchangeBody !== undefined) {
        res.end(options.exchangeBody);
        return;
      }
      res.end(
        JSON.stringify({
          credential: CREDENTIAL,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          userId: 'user-1',
          project: { id: '11111111-2222-4333-8444-555555555555', name: 'Fixture' },
          scope: 'projects',
        })
      );
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  assert(address && typeof address === 'object');
  try {
    return await fn(`http://127.0.0.1:${address.port}`, () => seen);
  } finally {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  }
}
function agentInit(dir: string, api: string, configDir: string, ...args: string[]) {
  return run(process.execPath, [cli, 'agent-init', ...args, '--dir', dir, '--api', api], {
    env: {
      ...process.env,
      ROSE_CONFIG_DIR: configDir,
      ROSE_TOKEN: '',
      ROSE_API_KEY: '',
      ROSE_USER_ID: '',
    },
  });
}
test('agent-init exchanges the code, saves it 0600 outside the repo and prints the agent steps', async () => {
  await withLoginApi(async (api, seen) => {
    const dir = fixture('agent-init');
    const configDir = join(root, 'agent-init-config');
    const result = await agentInit(dir, api, configDir, '--login-code', LOGIN_CODE);
    const saved = join(configDir, 'credentials.json');
    assert.equal(statSync(saved).mode & 0o777, 0o600);
    assert.equal(statSync(configDir).mode & 0o777, 0o700);
    const record = JSON.parse(readFileSync(saved, 'utf8'));
    assert.equal(record.credential, CREDENTIAL);
    assert.equal(record.apiUrl, api);
    assert(!result.stdout.includes(CREDENTIAL), 'the credential is never printed');
    assert(!result.stdout.includes(secret), 'env values are never printed');
    const steps = [
      '1. Detect the repository.',
      '2. Confirm or create the Rose project.',
      '3. List the environment files.',
      '4. APPROVAL: ask before uploading secrets.',
      '5. Upload through rose-sync.',
      '6. Propose setup commands.',
      '7. Verify.',
    ].map((step) => result.stdout.indexOf(step));
    assert(
      steps.every((at, i) => at >= 0 && (i === 0 || at > steps[i - 1])),
      `steps in order: ${steps}`
    );
    assert.match(result.stdout, /names only/);
    assert.match(result.stdout, /Wait for\s+an explicit yes/);
    assert.match(result.stdout, /Fixture" only/);
    assert.match(result.stdout, /push --project 11111111-2222-4333-8444-555555555555/);
    assert.deepEqual(seen(), ['POST /api/projects/cli-login-codes/exchange ']);

    const again = await agentInit(dir, api, configDir);
    assert.match(again.stdout, /1\. Detect the repository\./);
    const elsewhere = await run(
      process.execPath,
      [cli, 'push', '--dir', dir, '--api', 'http://127.0.0.1:1'],
      {
        env: { ...process.env, ROSE_CONFIG_DIR: configDir, ROSE_TOKEN: '', ROSE_API_KEY: '' },
      }
    ).catch((error: { stderr: string }) => error);
    assert.match(
      (elsewhere as { stderr: string }).stderr,
      /Not signed in to Rose/,
      'a saved credential is never sent to another backend'
    );
  });
});
test('agent-init refuses a used code and never stores a credential inside the checkout', async () => {
  await withLoginApi(async (api) => {
    const dir = fixture('agent-init-refuse');
    await assert.rejects(
      agentInit(dir, api, join(root, 'refuse-config'), '--login-code', `rlc_${'b'.repeat(32)}`),
      /copy a fresh setup prompt/i
    );
    await assert.rejects(
      agentInit(dir, api, join(root, 'refuse-config'), '--login-code', 'not-a-code'),
      /not a Rose login code/
    );
    const inside = join(dir, '.rose');
    await assert.rejects(
      agentInit(dir, api, inside, '--login-code', LOGIN_CODE),
      /inside the repository/
    );
    assert.throws(() => statSync(join(inside, 'credentials.json')), /ENOENT/);
    const expiredDir = join(root, 'expired-config');
    mkdirSync(expiredDir, { mode: 0o700 });
    writeFileSync(
      join(expiredDir, 'credentials.json'),
      JSON.stringify({ apiUrl: api, credential: CREDENTIAL, expiresAt: '2000-01-01T00:00:00Z' }),
      { mode: 0o600 }
    );
    await assert.rejects(agentInit(dir, api, expiredDir), /Not signed in to Rose/);
    const status = await agentInit(dir, api, expiredDir, 'status', '--json');
    assert.equal(JSON.parse(status.stdout).stage, 'signed_out');
  });
});
test('agent-init rejects malformed saved logins without using their credential', async () => {
  await withLoginApi(async (api, seen) => {
    const dir = fixture('malformed-saved-login');
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const records = [
      { apiUrl: api, credential: CREDENTIAL },
      { apiUrl: api, credential: CREDENTIAL, expiresAt: 'invalid-expiry' },
      { credential: CREDENTIAL, expiresAt: future },
    ];
    for (const [index, record] of records.entries()) {
      const configDir = join(root, `malformed-saved-${index}`);
      mkdirSync(configDir, { mode: 0o700 });
      writeFileSync(join(configDir, 'credentials.json'), JSON.stringify(record), { mode: 0o600 });
      await assert.rejects(agentInit(dir, api, configDir), /Not signed in to Rose/);
      const status = await agentInit(dir, api, configDir, 'status', '--json');
      assert.equal(JSON.parse(status.stdout).stage, 'signed_out');
      assert(!status.stdout.includes(CREDENTIAL), 'malformed credentials are never printed');
    }
    assert.deepEqual(seen(), [], 'malformed saved credentials never reach the API');
  });
});

test('agent-init rejects malformed successful exchanges without saving credentials', async () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const bodies = [
    'not-json',
    '{}',
    JSON.stringify({ credential: CREDENTIAL }),
    JSON.stringify({ expiresAt: future }),
    JSON.stringify({ credential: CREDENTIAL, expiresAt: 'invalid-expiry' }),
  ];
  for (const [index, exchangeBody] of bodies.entries()) {
    await withLoginApi(
      async (api, seen) => {
        const dir = fixture(`malformed-exchange-${index}`);
        const configDir = join(root, `malformed-exchange-config-${index}`);
        const failure = await agentInit(dir, api, configDir, '--login-code', LOGIN_CODE).then(
          () => assert.fail('malformed exchange must fail'),
          (error: { stderr: string }) => error
        );
        assert.match(failure.stderr, /backend returned an unexpected response/);
        assert(!failure.stderr.includes(CREDENTIAL), 'exchange failures never print credentials');
        assert.throws(() => statSync(join(configDir, 'credentials.json')), /ENOENT/);
        assert.deepEqual(seen(), ['POST /api/projects/cli-login-codes/exchange ']);
      },
      { exchangeBody }
    );
  }
});

test('agent-init rejects in-checkout config before any exchange request', async () => {
  await withLoginApi(async (api, seen) => {
    const dir = fixture('custody-before-exchange');
    const configDir = join(dir, '.rose');
    await assert.rejects(
      agentInit(dir, api, configDir, '--login-code', LOGIN_CODE),
      /inside the repository/
    );
    assert.deepEqual(seen(), [], 'a custody failure must not consume the one-time code');
    assert.throws(() => statSync(join(configDir, 'credentials.json')), /ENOENT/);
  });
});

test('the rose package exposes the bin the onboarding prompt tells agents to install', async () => {
  const pkgDir = resolve('../scripts/lib/rose-sync');
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@roselabs.ai/cli', 'the scope Andy owns on npm');
  assert.equal(pkg.private, undefined, 'the prompt installs it from the public registry');
  assert.equal(pkg.publishConfig?.access, 'public', 'scoped packages publish private by default');
  assert.deepEqual(Object.keys(pkg.bin), ['rose']);
  for (const file of pkg.files) statSync(join(pkgDir, file));
  const help = await run(process.execPath, [join(pkgDir, pkg.bin.rose), 'help']);
  assert.match(help.stdout, /^usage: rose /);
  assert.match(help.stdout, /rose agent-init --login-code CODE/);
  const prompt = readFileSync(resolve('../front-end/src/lib/agentInitPrompt.ts'), 'utf8');
  assert(prompt.includes(`'${pkg.name}'`), `front-end prompt installs ${pkg.name}`);
  assert(prompt.includes(`'${Object.keys(pkg.bin)[0]}'`), 'front-end prompt runs the rose bin');
});
