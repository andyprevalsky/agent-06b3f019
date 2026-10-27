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
import { projectSyncClientFiles } from '../../providers/projects/syncClient';
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

test('downloaded setup helper contains only its four public source files', () => {
  const files = projectSyncClientFiles();
  assert.equal(files.length, 4);
  assert.deepEqual(
    files.map((file) => file.path),
    [
      'rose-sync',
      'lib/rose-sync/cli.mjs',
      'lib/rose-sync/capture.mjs',
      'lib/rose-sync/onboarding.mjs',
    ]
  );
  assert(files.every((file) => !file.content.includes(secret)));
  assert(files.some((file) => file.content.includes('configureOnboarding')));
});
