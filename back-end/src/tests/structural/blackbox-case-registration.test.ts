/**
 * Structural test: every black-box case file is actually reachable from a runner.
 *
 * `src/tests/blackbox/run.ts` discovers ONLY `*.blackbox.ts`. The split-out case
 * files (`*.cases.ts`, `*.case.ts`) run solely because their domain entrypoint
 * imports them — e.g. `agents.blackbox.ts` does
 * `await import('./agents-list-create.cases')`. Add a case file and forget that
 * one line and its `test(...)` registrations never execute, while the suite still
 * reports green: the tests exist, look like coverage in review, and measure
 * nothing. That is exactly the failure mode CLAUDE.md rule 1 forbids.
 *
 * The agents (Python) suite already guards this via
 * `agents/tests/structural/structural_test_registration.py`; this is the missing
 * TypeScript half. It is a pure ratchet — there is no debt ledger because every
 * case file is registered today, so a new orphan is always a new mistake.
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const blackboxDir = path.resolve(__dirname, '../blackbox');

const CASE_FILE_PATTERN = /\.(cases|case)\.ts$/;
// `from './x'`, `import './x'`, and `await import('./x')` — with or without a
// `.ts`/`.js` extension. Explicit fixture URLs are child-process entrypoints;
// traverse them too so their imported case files remain part of the ratchet.
const RELATIVE_IMPORT_PATTERN = /(?:from|import|new\s+URL)\s*\(?\s*['"]\.\/([\w.-]+)['"]/g;

function moduleKey(fileName: string): string {
  return fileName.replace(/\.(ts|js)$/, '');
}

/** Module keys imported by `fileName`, excluding self-references. */
function importsOf(fileName: string): string[] {
  const source = fs.readFileSync(path.join(blackboxDir, fileName), 'utf8');
  const found = new Set<string>();
  for (const match of source.matchAll(RELATIVE_IMPORT_PATTERN)) {
    const key = moduleKey(match[1]);
    if (key !== moduleKey(fileName)) found.add(key);
  }
  return [...found];
}

function testEveryCaseFileIsReachableFromARunner(): void {
  const files = fs.readdirSync(blackboxDir).filter((f) => f.endsWith('.ts'));
  const entrypoints = files.filter((f) => f.endsWith('.blackbox.ts'));
  const caseFiles = files.filter((f) => CASE_FILE_PATTERN.test(f));

  assert(entrypoints.length > 0, 'No *.blackbox.ts entrypoints found — the runner glob is broken');
  assert(caseFiles.length > 0, 'No *.cases.ts files found — this guard would pass vacuously');

  const byKey = new Map(files.map((f) => [moduleKey(f), f]));
  const reachable = new Set<string>();
  const queue = entrypoints.map(moduleKey);
  while (queue.length > 0) {
    const key = queue.pop()!;
    if (reachable.has(key)) continue;
    reachable.add(key);
    const file = byKey.get(key);
    if (file === undefined) continue;
    queue.push(...importsOf(file));
  }

  const orphans = caseFiles.filter((f) => !reachable.has(moduleKey(f)));
  assert(
    orphans.length === 0,
    `${orphans.length} black-box case file(s) are never imported by any *.blackbox.ts runner, ` +
      `so their tests never run: ${orphans.join(', ')}. Register each one with ` +
      "`await import('./<name>')` in its domain entrypoint."
  );
}

function main(): void {
  testEveryCaseFileIsReachableFromARunner();
}

try {
  main();
  process.stdout.write('blackbox case registration structural tests passed\n');
} catch (error: unknown) {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
}
