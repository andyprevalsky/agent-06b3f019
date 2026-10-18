/** Exercise the operator import command against the actual credential router. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

interface ImportFixture {
  base: string;
  userId: string;
  connection: Record<string, unknown>;
  readSaved: () => Promise<Record<string, unknown>>;
}

async function runImport(args: string[]): Promise<{ status: number | null; output: string }> {
  return new Promise((fulfill, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', resolve('scripts/connect-lantern-people.ts'), ...args],
      { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', reject);
    child.on('exit', (status) => fulfill({ status, output }));
  });
}

export async function testLanternImportCommand(fixture: ImportFixture): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'rose-lantern-import-'));
  const path = join(directory, 'connection.json');
  const stored = {
    version: 1,
    protection: 'owner-only-file',
    connection: fixture.connection,
  };
  await writeFile(path, JSON.stringify(stored), { mode: 0o600 });
  const args = ['--backend', fixture.base, '--user-id', fixture.userId, '--connection-file', path];
  const secrets = [fixture.connection.token, fixture.connection.refreshToken];
  function assertSafe(output: string) {
    for (const secret of secrets) {
      assert(typeof secret === 'string' && !output.includes(secret));
    }
    assert(!output.includes(process.env.BACKEND_API_KEY!));
    assert(!output.includes(process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY!));
  }
  try {
    const imported = await runImport(args);
    assert.equal(imported.status, 0, imported.output);
    assertSafe(imported.output);
    const lines = imported.output.trim().split('\n');
    const result = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
    assert.equal(result.connected, true);
    assert.equal(result.userId, fixture.userId);
    assert.equal(result.connectionId, fixture.connection.connectionId);
    assert.deepEqual(await fixture.readSaved(), fixture.connection);

    await chmod(path, 0o644);
    const exposedFile = await runImport(args);
    assert.equal(exposedFile.status, 1);
    assertSafe(exposedFile.output);
    assert.deepEqual(await fixture.readSaved(), fixture.connection);
    await chmod(path, 0o600);

    const unsafeDestination = await runImport([
      '--backend',
      'http://unsafe.example',
      ...args.slice(2),
    ]);
    assert.equal(unsafeDestination.status, 1);
    assertSafe(unsafeDestination.output);
    assert.deepEqual(await fixture.readSaved(), fixture.connection);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
