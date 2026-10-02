#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

let passed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
  passed++;
  process.stdout.write(`  \u2705 ${name}\n`);
}

const syncScript = join(process.cwd(), 'scripts', 'sync-prisma-client.sh');
const root = mkdtempSync(join(tmpdir(), 'sync-prisma-client-'));
const backendDir = join(root, 'back-end');
const schemaPath = join(backendDir, 'prisma', 'schema.prisma');
const clientPackagePath = join(backendDir, 'node_modules', '@prisma', 'client', 'package.json');
const generatedIndexPath = join(backendDir, 'node_modules', '.prisma', 'client', 'index.js');
const generateLog = join(root, 'generate.log');
const fakeBin = join(root, 'bin');

// Prisma embeds a reformatted copy of the schema, so the fake hashes something
// other than the source bytes, like the real generator.
mkdirSync(join(backendDir, 'prisma'), { recursive: true });
mkdirSync(join(backendDir, 'node_modules', '@prisma', 'client'), { recursive: true });
mkdirSync(fakeBin, { recursive: true });
writeFileSync(
  join(fakeBin, 'npx'),
  `#!/usr/bin/env bash
set -euo pipefail
[ "$*" = "prisma generate" ] || { echo "unexpected npx $*" >&2; exit 2; }
echo generate >> "${generateLog}"
sleep 1
version="$(node -p "require('./node_modules/@prisma/client/package.json').version")"
hash="$(node -e "const s = require('fs').readFileSync('prisma/schema.prisma'); console.log(require('crypto').createHash('sha256').update('formatted').update(s).digest('hex'))")"
mkdir -p node_modules/.prisma/client
printf '{"clientVersion": "%s", "inlineSchemaHash": "%s"}\\n' "$version" "$hash" > node_modules/.prisma/client/index.js
`
);
chmodSync(join(fakeBin, 'npx'), 0o755);

function installClientVersion(version: string): void {
  writeFileSync(clientPackagePath, JSON.stringify({ name: '@prisma/client', version }));
}

function generateCount(): number {
  try {
    return readFileSync(generateLog, 'utf8').trim().split('\n').length;
  } catch {
    return 0;
  }
}

async function sync(): Promise<void> {
  await execFileAsync('bash', [syncScript, backendDir], {
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      ROSE_WORKSPACE_DB_LOCK_DIR: join(root, 'locks'),
      ROSE_WORKSPACE_DB_LOCK_POLL_SECONDS: '1',
    },
  });
}

async function manualGenerate(): Promise<void> {
  await execFileAsync(join(fakeBin, 'npx'), ['prisma', 'generate'], { cwd: backendDir });
}

writeFileSync(schemaPath, 'model A {\n  id String @id\n}\n');
installClientVersion('5.22.0');

async function main(): Promise<void> {
  await test('a missing client is generated once, then left untouched', async () => {
    await sync();
    assert.equal(generateCount(), 1);
    const generatedAt = statSync(generatedIndexPath).mtimeMs;
    await sync();
    assert.equal(generateCount(), 1, 'a fresh client must not be regenerated');
    assert.equal(statSync(generatedIndexPath).mtimeMs, generatedAt);
  });

  await test('a schema edit regenerates the client', async () => {
    writeFileSync(schemaPath, 'model A {\n  id String @id\n  name String\n}\n');
    await sync();
    assert.equal(generateCount(), 2);
  });

  await test('a manual generate of the same schema does not force another', async () => {
    await manualGenerate();
    await sync();
    assert.equal(generateCount(), 3, 'only the manual generate ran');
  });

  await test('a client generated from another schema is regenerated', async () => {
    const current = readFileSync(generatedIndexPath, 'utf8');
    const otherHash = createHash('sha256').update('another schema').digest('hex');
    writeFileSync(
      generatedIndexPath,
      current.replace(/"inlineSchemaHash": "[0-9a-f]+"/, `"inlineSchemaHash": "${otherHash}"`)
    );
    await sync();
    assert.equal(generateCount(), 4);
  });

  await test('a client from another @prisma/client version is regenerated', async () => {
    installClientVersion('5.23.0');
    await sync();
    assert.equal(generateCount(), 5);
    await sync();
    assert.equal(generateCount(), 5);
  });

  await test('concurrent launchers on a stale client generate it once', async () => {
    writeFileSync(schemaPath, 'model B {\n  id String @id\n}\n');
    await Promise.all([sync(), sync(), sync()]);
    assert.equal(generateCount(), 6);
  });

  process.stdout.write(`\nsync-prisma-client unit tests: ${passed} passed\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : error}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(root, { recursive: true, force: true });
  });
