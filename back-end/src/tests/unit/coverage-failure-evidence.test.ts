import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const helper = join(process.cwd(), 'scripts', 'coverage-failure-evidence.sh');
const coverageScript = readFileSync(join(process.cwd(), 'scripts', 'run-coverage.sh'), 'utf8');

const root = mkdtempSync(join(tmpdir(), 'coverage-failure-evidence-'));
try {
  const serverLog = join(root, 'coverage', 'server.log');
  const artifactDir = join(root, 'coverage', 'blackbox-run');
  const evidenceRoot = join(root, '.context', 'test-runs');
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(serverLog, 'P2028 Unable to start a transaction in the given time\n');
  writeFileSync(join(artifactDir, 'runner.log'), 'FAIL imessage\n');
  writeFileSync(join(artifactDir, 'manifest.json'), '{"domains":["imessage"]}\n');
  const pressureLog = join(artifactDir, 'host-pressure.log');

  const evidenceDir = execFileSync(
    'bash',
    [
      '-c',
      'source "$1"; record_host_pressure "$5" suite-start; record_host_pressure "$5" suite-failed; preserve_coverage_failure "$2" "$3" "$4"',
      'evidence',
      helper,
      serverLog,
      artifactDir,
      evidenceRoot,
      pressureLog,
    ],
    { encoding: 'utf8' }
  ).trim();

  // The next coverage run deletes both fixed paths before it starts.
  rmSync(serverLog);
  rmSync(artifactDir, { recursive: true });

  assert.ok(
    evidenceDir.startsWith(join(evidenceRoot, 'backend-coverage-failed-')),
    `evidence must land in a per-run directory under .context/test-runs, got ${evidenceDir}`
  );
  assert.equal(
    readFileSync(join(evidenceDir, 'server.log'), 'utf8'),
    'P2028 Unable to start a transaction in the given time\n',
    'the failed run backend log must survive the next run'
  );
  assert.equal(readFileSync(join(evidenceDir, 'runner.log'), 'utf8'), 'FAIL imessage\n');
  assert.ok(existsSync(join(evidenceDir, 'manifest.json')), 'blackbox artifacts must be copied');

  const pressure = readFileSync(join(evidenceDir, 'host-pressure.log'), 'utf8');
  assert.match(pressure, /^== suite-start \d{4}-\d{2}-\d{2}T/m);
  assert.match(pressure, /^== suite-failed \d{4}-\d{2}-\d{2}T/m);
  if (existsSync('/proc/pressure/memory')) {
    assert.match(
      pressure,
      /^memory full avg10=\S+ avg60=\S+ avg300=\S+ total=\d+$/m,
      'PSI totals must be recorded so a host-wide stall can be classified'
    );
    assert.match(pressure, /^MemAvailable:\s+\d+ kB$/m);
  }

  const secondDir = execFileSync(
    'bash',
    [
      '-c',
      'source "$1"; preserve_coverage_failure "$2" "$3" "$4"',
      'evidence',
      helper,
      serverLog,
      artifactDir,
      evidenceRoot,
    ],
    { encoding: 'utf8' }
  ).trim();
  assert.ok(existsSync(secondDir), 'missing inputs still yield an evidence directory');
  assert.notEqual(secondDir, evidenceDir, 'a later failure must not overwrite earlier evidence');
} finally {
  rmSync(root, { recursive: true, force: true });
}

const failureBranchStart = coverageScript.indexOf(
  'if [[ "$TEST_EXIT" -ne 0 || "$UNIT_EXIT" -ne 0 ]]; then'
);
assert.ok(failureBranchStart >= 0, 'run-coverage.sh must branch on a failed test phase');
const failureBranch = coverageScript.slice(
  failureBranchStart,
  coverageScript.indexOf('\nfi\n', failureBranchStart)
);
assert.match(
  failureBranch,
  /preserve_coverage_failure "\$COV_LOG" "\$BLACKBOX_ARTIFACT_DIR" "\$ROOT_DIR\/\.context\/test-runs"/,
  'a failed test phase must copy the backend log and blackbox artifacts before exiting'
);
assert.ok(
  coverageScript.indexOf('record_host_pressure "$HOST_PRESSURE_LOG" "suite-start"') <
    coverageScript.indexOf('bash scripts/run-blackbox-tests.sh'),
  'host pressure must be snapshotted before the suites start'
);
assert.doesNotMatch(
  coverageScript,
  /BLACKBOX_ARTIFACT_DIR\/backend\.log/,
  'the backend log is coverage/server.log; never print a path that is not written'
);

process.stdout.write('coverage failure evidence contracts passed\n');
