#!/usr/bin/env node
// Test lanes share node_modules with live local stacks. Dependency preparation
// owns generation; a test launcher may check that client, but never rewrite it.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let temporaryDirectory;
try {
  const clientPackage = require.resolve('@prisma/client/package.json');
  const clientRequire = createRequire(clientPackage);
  const generatedSchema = join(
    dirname(clientRequire.resolve('.prisma/client/default')),
    'schema.prisma'
  );
  const cliPackage = require.resolve('prisma/package.json');
  const clientVersion = JSON.parse(readFileSync(clientPackage, 'utf8')).version;
  const cliVersion = JSON.parse(readFileSync(cliPackage, 'utf8')).version;
  if (clientVersion !== cliVersion) throw new Error('Installed Prisma versions disagree.');

  temporaryDirectory = mkdtempSync(join(tmpdir(), 'rose-prisma-freshness-'));
  const schemaCopy = join(temporaryDirectory, 'schema.prisma');
  copyFileSync(fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url)), schemaCopy);
  // Generation stores Prisma's formatted schema. Use the same installed CLI
  // on a private copy so harmless source formatting does not look stale.
  const formatted = spawnSync(
    process.execPath,
    [require.resolve('prisma'), 'format', '--schema', schemaCopy],
    { cwd: temporaryDirectory, stdio: 'ignore', timeout: 10000 }
  );
  if (formatted.error || formatted.status !== 0) {
    throw new Error('Installed Prisma could not format the schema.');
  }
  if (!readFileSync(schemaCopy).equals(readFileSync(generatedSchema))) {
    throw new Error('The generated schema differs from the checked-out schema.');
  }
} catch {
  console.error(
    'Prisma client is stale or unavailable. Stop local stacks, run ' +
      '`cd back-end && npm run prisma:generate`, then restart tests.'
  );
  process.exitCode = 1;
} finally {
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
}
