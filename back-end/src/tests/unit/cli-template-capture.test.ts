/** Executes the production capture Python against a private filesystem fixture. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { mock } from 'node:test';
import { Sandbox } from 'e2b';
import { readTemplateCredentials } from '../../providers/cliTemplate';

const exec = promisify(execFile);

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'rose-cli-capture-'));
  const home = join(root, 'home');
  const outside = join(root, 'outside');
  await mkdir(join(home, '.yc'), { recursive: true });
  await mkdir(outside);
  const secret = 'PRIVATE-CREDENTIAL-CONTENT';
  let connections = 0;
  let runs = 0;
  const patched = mock.method(Sandbox, 'connect', async () => {
    connections += 1;
    return {
      commands: {
        run: async (command: string) => {
          runs += 1;
          // Replace only the sandbox HOME at the process boundary. All capture
          // code, descriptor flags, supplied paths and validation remain real.
          const result = await exec('bash', ['-c', command.replaceAll('/home/user', home)], {
            cwd: home,
            timeout: 5_000,
            maxBuffer: 1024 * 1024,
          });
          return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
        },
      },
    } as unknown as Sandbox;
  });
  async function denied(paths: string[]) {
    await assert.rejects(readTemplateCredentials('fixture-sandbox', paths), (error: unknown) => {
      assert(error instanceof Error);
      assert.equal(error.message, 'CLI credentials could not be captured safely');
      assert(!error.message.includes(secret));
      assert(!error.message.includes(outside));
      return true;
    });
  }
  try {
    const binary = Buffer.from([0, 1, 255, 128, 10]);
    await writeFile(join(home, '.yc', 'credentials.json'), binary);
    assert.deepEqual(await readTemplateCredentials('fixture-sandbox', ['.yc/credentials.json']), [
      { path: '.yc/credentials.json', data: binary.toString('base64') },
    ]);
    await writeFile(join(outside, 'secret.json'), secret);
    await symlink(outside, join(home, 'ancestor-link'));
    await denied(['ancestor-link/secret.json']);
    await symlink(join(outside, 'secret.json'), join(home, '.yc', 'final-link'));
    await denied(['.yc/final-link']);
    await mkdir(join(home, '.yc', 'directory'));
    await denied(['.yc/directory']);
    await exec('mkfifo', [join(home, '.yc', 'fifo')]);
    await denied(['.yc/fifo']);
    await denied(['.yc/missing']);
    await writeFile(join(home, '.yc', 'oversized'), Buffer.alloc(65_537, 7));
    await denied(['.yc/oversized']);
    const totalPaths = Array.from({ length: 5 }, (_, index) => `.yc/bundle-${index}`);
    for (const path of totalPaths) await writeFile(join(home, path), Buffer.alloc(65_536, 9));
    assert.equal(
      (await readTemplateCredentials('fixture-sandbox', totalPaths.slice(0, 4))).length,
      4
    );
    await denied(totalPaths);
    const priorConnections = connections;
    await assert.rejects(
      readTemplateCredentials('fixture-sandbox', ['../outside/secret.json']),
      /Invalid CLI credential paths/
    );
    await assert.rejects(
      readTemplateCredentials('fixture-sandbox', ['.yc/credentials.json', '.yc/credentials.json']),
      /Invalid CLI credential paths/
    );
    assert.deepEqual(await readTemplateCredentials('fixture-sandbox', []), []);
    assert.equal(connections, priorConnections, 'invalid and empty requests do not connect');
    assert(runs >= 8, 'tests executed the production Python, including failure paths');
    process.stdout.write(
      'CLI capture: real Python reads binary files, blocks ancestor/final symlinks and nonregular files, enforces size limits, and sanitizes errors\n'
    );
  } finally {
    patched.mock.restore();
    await rm(root, { recursive: true, force: true });
  }
}
main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
