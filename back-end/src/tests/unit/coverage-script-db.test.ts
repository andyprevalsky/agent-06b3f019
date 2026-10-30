import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const coverageScript = readFileSync(join(process.cwd(), 'scripts', 'run-coverage.sh'), 'utf8');

// Replay the production URL-selection branch, stopping before schema/provider work.
const explicitDbBranch = coverageScript.slice(
  coverageScript.indexOf('if [[ "${ROSE_DEPLOY_WORKTREE:-0}"') >= 0
    ? coverageScript.indexOf('if [[ "${ROSE_DEPLOY_WORKTREE:-0}"')
    : coverageScript.indexOf('if [[ -n "${BACKEND_COVERAGE_DATABASE_URL:-}" ]]'),
  coverageScript.indexOf('elif [[ -f "$STACK_MANIFEST" ]]')
);
assert.ok(explicitDbBranch.length > 100, 'production explicit database branch must exist');
const dbRoot = mkdtempSync(join(tmpdir(), 'coverage-prepared-db-'));
try {
  const identity = 'descend-I99-fixture';
  const prepared = 'victoria_deploy_descend_I99_fixture';
  mkdirSync(join(dbRoot, '.context'));
  const marker = join(dbRoot, '.context', 'deploy-system-pg.db');
  writeFileSync(marker, `${prepared}\n`);
  const runDbSelection = (url: string, overrides: Record<string, string> = {}) =>
    spawnSync(
      'bash',
      ['-c', `${explicitDbBranch}\nfi\nprintf 'SELECTED=%s\\n' "$LOCAL_PSQL_URL"`],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          // run-coverage.sh defines SCRIPT_DIR at its top, outside the replayed
          // slice; the branch resolves the prepared URL through
          // scripts/coverage-database-url.mjs relative to it.
          SCRIPT_DIR: join(process.cwd(), 'scripts'),
          ROOT_DIR: dbRoot,
          WORKSPACE_HINT: identity,
          ROSE_DEPLOY_WORKTREE: '1',
          ROSE_USE_SYSTEM_PG: 'true',
          ROSE_DEPLOY_WORKTREE_PATH: dbRoot,
          BACKEND_COVERAGE_DATABASE_URL: url,
          ...overrides,
        },
      }
    );
  const url = `postgresql://postgres:postgres@localhost:5432/${prepared}`;
  // No real DB mutation: the production readiness probe is a read-only SELECT 1.
  const fakeBin = join(dbRoot, 'bin');
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, 'psql'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(fakeBin, 'psql'), 0o755);
  const run = (value: string, overrides: Record<string, string> = {}) =>
    runDbSelection(value, { PATH: `${fakeBin}:${process.env.PATH ?? ''}`, ...overrides });
  const accepted = run(url);
  assert.equal(
    accepted.status,
    0,
    `normal prepared system DB rejected: ${accepted.stdout}${accepted.stderr}`
  );
  assert.match(accepted.stdout, new RegExp(`SELECTED=.*${prepared}`));
  assert.notEqual(run('').status, 0, 'isolated system coverage must never fall back to shared DB');
  for (const rejected of [
    url.replace('localhost', 'remote.example'),
    url.replace(':5432', ':5433'),
    url.replace(prepared, 'victoria'),
    url.replace(prepared, 'victoria_deploy_foreign'),
    `${url}?schema=public`,
    `${url}#fragment`,
    url.replace('postgresql:', 'https:'),
  ])
    assert.notEqual(run(rejected).status, 0, `unsafe database accepted: ${rejected}`);
  assert.notEqual(run(url, { ROSE_DEPLOY_WORKTREE_PATH: `${dbRoot}/foreign` }).status, 0);
  assert.notEqual(run(url, { WORKSPACE_HINT: 'foreign' }).status, 0);
  assert.notEqual(
    run(`postgresql://postgres:postgres@localhost:5432/victoria_${identity}`).status,
    0,
    'deploy mode must not adopt the primary workspace database'
  );
  // The dedicated unit pass (shard token "units") and every blackbox shard own
  // a derived database: the resolved URL on line 1 must point at it, not at
  // the prepared base database (CodeRabbit on PR #1638: the units branch set
  // the derived name without updating the URL).
  const resolver = join(process.cwd(), 'scripts', 'coverage-database-url.mjs');
  const resolve = (token: string) =>
    spawnSync('node', [resolver, identity, dbRoot, token], {
      encoding: 'utf8',
      env: {
        ...process.env,
        BACKEND_COVERAGE_DATABASE_URL: url,
        ROSE_DEPLOY_WORKTREE: '1',
        ROSE_DEPLOY_WORKTREE_PATH: dbRoot,
      },
    });
  for (const [token, suffix] of [
    ['units', '_s0'],
    ['1/2', '_s1'],
    ['2/2', '_s2'],
  ] as const) {
    const resolved = resolve(token);
    assert.equal(resolved.status, 0, `resolver rejected ${token}: ${resolved.stderr}`);
    const [resolvedUrl, derived] = resolved.stdout.split('\n');
    assert.equal(derived, `${prepared}${suffix}`, `derived name for ${token}`);
    assert.equal(
      new URL(resolvedUrl).pathname,
      `/${prepared}${suffix}`,
      `${token} must connect to its derived database, not the prepared base`
    );
  }
  assert.equal(new URL(resolve('').stdout.split('\n')[0]).pathname, `/${prepared}`);
  const unitPass = run(url, { COVERAGE_DB_TOKEN: 'units' });
  assert.equal(unitPass.status, 0, `unit pass rejected: ${unitPass.stdout}${unitPass.stderr}`);
  assert.match(unitPass.stdout, new RegExp(`SELECTED=.*/${prepared}_s0$`, 'm'));
  writeFileSync(marker, 'victoria_deploy_foreign\n');
  assert.notEqual(run(url).status, 0, 'foreign marker accepted');
  rmSync(marker);
  assert.notEqual(run(url).status, 0, 'missing marker accepted');
  const primary = `postgresql://postgres:postgres@localhost:5432/victoria_${identity}`;
  assert.equal(run(primary, { ROSE_DEPLOY_WORKTREE: '0' }).status, 0, 'primary rule changed');
  assert.notEqual(run(url, { ROSE_DEPLOY_WORKTREE: '0' }).status, 0);
} finally {
  rmSync(dbRoot, { recursive: true, force: true });
}
process.stdout.write('prepared coverage database selection: PASS\n');
