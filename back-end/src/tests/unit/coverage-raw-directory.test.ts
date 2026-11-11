import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = join(process.cwd(), 'scripts', 'coverage-raw-directory.sh');
const root = mkdtempSync(join(tmpdir(), 'coverage-raw-directory-test-'));
const command = 'source "$1"; coverage_raw_directory "$2" "$3"';
const args = ['-c', command, 'coverage-directory-test', script, root, '-shard1'];
try {
  const run = (rawRoot: string) =>
    execFileSync('bash', args, {
      env: { ...process.env, BACKEND_COVERAGE_TMP_ROOT: rawRoot },
      encoding: 'utf8',
    }).trim();
  assert.equal(run(''), join(root, 'coverage', 'tmp-shard1'));
  const first = run(root);
  const second = run(root);
  assert.notEqual(first, second, 'each invocation must own a distinct raw directory');
  for (const path of [first, second]) {
    assert.equal(path.startsWith(join(root, 'rose-backend-coverage-shard1.')), true);
    assert.equal(existsSync(path), true);
  }
  const sentinel = join(root, 'existing-file');
  writeFileSync(sentinel, 'preserve');
  for (const badRoot of ['relative-path', join(root, 'missing'), sentinel]) {
    const result = spawnSync('bash', args, {
      env: { ...process.env, BACKEND_COVERAGE_TMP_ROOT: badRoot },
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /existing absolute directory/);
  }
  assert.equal(
    existsSync(sentinel),
    true,
    'invalid storage selection must preserve existing files'
  );
  console.log('coverage raw directory test passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
