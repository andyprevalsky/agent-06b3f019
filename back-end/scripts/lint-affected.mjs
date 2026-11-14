#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, normalize, relative, resolve } from 'node:path';
import ts from 'typescript';
import { ESLint } from 'eslint';
import { lintInTypeOrder } from './lint-phase-order.mjs';

const root = process.cwd();
const sourceRoot = resolve(root, 'src');
const rawArgs = process.argv.slice(2);
const fix = rawArgs.includes('--fix');
const printOnly = rawArgs.includes('--print');
const requested = rawArgs.filter((arg) => arg !== '--fix' && arg !== '--print');

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [normalize(path)] : [];
  });
}

function resolveRelativeImport(importer, specifier) {
  if (!specifier.startsWith('.')) return undefined;
  const base = resolve(dirname(importer), specifier);
  const candidates = extname(base)
    ? [base]
    : [base + '.ts', base + '.tsx', join(base, 'index.ts'), join(base, 'index.tsx')];
  return candidates.map(normalize).find((candidate) => existsSync(candidate));
}

const files = sourceFiles(sourceRoot);
const fileSet = new Set(files);
const reverseImports = new Map(files.map((file) => [file, new Set()]));

for (const importer of files) {
  const parsed = ts.preProcessFile(readFileSync(importer, 'utf8'), true, true);
  for (const imported of parsed.importedFiles) {
    const dependency = resolveRelativeImport(importer, imported.fileName);
    if (dependency !== undefined && fileSet.has(dependency)) {
      reverseImports.get(dependency).add(importer);
    }
  }
}

const affected = new Set();
const queue = requested
  .map((file) => normalize(resolve(root, file)))
  .filter((file) => fileSet.has(file));

while (queue.length > 0) {
  const file = queue.shift();
  if (affected.has(file)) continue;
  affected.add(file);
  for (const importer of reverseImports.get(file) ?? []) queue.push(importer);
}

const lintFiles = [...affected].map((file) => relative(root, file)).sort();
if (lintFiles.length === 0) process.exit(0);

if (printOnly) {
  process.stdout.write(lintFiles.join('\n') + '\n');
  process.exit(0);
}

if (fix) {
  const result = spawnSync('npx', ['eslint', '--fix', ...lintFiles], { cwd: root, stdio: 'inherit' });
  if (result.error !== undefined) throw result.error;
  process.exit(result.status ?? 1);
}

try {
  const eslint = new ESLint({ cwd: root });
  const results = await lintInTypeOrder(eslint, lintFiles);
  results.sort((left, right) => left.filePath < right.filePath ? -1 : left.filePath > right.filePath ? 1 : 0);
  const formatter = await eslint.loadFormatter();
  const output = await formatter.format(results);
  if (output) process.stdout.write(output);
  process.exitCode = results.some((result) => result.errorCount > 0 || result.fatalErrorCount > 0) ? 1 : 0;
} catch (error) {
  // Match the CLI's configuration/engine failure status, distinct from lint errors.
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 2;
}
