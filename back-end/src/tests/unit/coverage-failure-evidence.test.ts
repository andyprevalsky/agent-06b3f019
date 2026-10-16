import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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

// Execute the real EXIT cleanup with an owned child that flushes raw data on TERM.
const cleanupStart = coverageScript.indexOf('cleanup() {');
const cleanupEnd = coverageScript.indexOf('\ntrap cleanup EXIT', cleanupStart);
assert.ok(cleanupStart >= 0 && cleanupEnd > cleanupStart);
const cleanupFunction = coverageScript.slice(cleanupStart, cleanupEnd);
const printPortStart = coverageScript.indexOf('if [[ "$PRINT_COVERAGE_PORT" == "1" ]]; then');
const tempSetupStart = coverageScript.indexOf('\nfi\n', printPortStart) + 4;
const tempSetupEnd = coverageScript.indexOf('\nexport TEST_BASE_URL=', tempSetupStart);
assert.ok(printPortStart >= 0 && tempSetupEnd > tempSetupStart);
const tempSetup = coverageScript.slice(tempSetupStart, tempSetupEnd);
const cleanupRoot = mkdtempSync(join(tmpdir(), 'coverage-raw-retention-'));
try {
  for (const mode of [
    'failure',
    'failure-before-evidence',
    'success',
    'archive-failure',
    'partial-copy',
    'existing-archive',
  ] as const) {
    const fixture = join(cleanupRoot, mode);
    const raw = join(fixture, 'raw');
    const evidence = join(fixture, 'evidence');
    mkdirSync(raw, { recursive: true });
    writeFileSync(join(raw, 'unit.json'), '{"result":[]}\n');
    writeFileSync(join(raw, '.hidden-map'), 'source-map evidence');
    if (mode === 'archive-failure') writeFileSync(evidence, 'not a directory');
    else mkdirSync(evidence);
    if (mode === 'existing-archive') {
      mkdirSync(join(evidence, 'raw-v8'));
      writeFileSync(join(evidence, 'raw-v8', 'earlier.json'), 'earlier evidence');
    }
    writeFileSync(
      join(fixture, 'child.sh'),
      `trap 'printf "late V8 flush" > "$1/late.json"; exit 0' TERM\ntouch "$2"\nwhile :; do sleep 0.1; done\n`
    );
    const result = spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail
set -m
COV_TMP="$1"
EVIDENCE_DIR="$2"
ROOT_DIR="$3"
${mode === 'failure-before-evidence' ? 'unset EVIDENCE_DIR' : ''}
COVERAGE_PROCESS_GROUPS_FILE="$3/groups"
UNIT_PID=""
BLACKBOX_PID=""
reservation_receipt="$3/released"
release_coverage_reservations() { printf 'released' > "$reservation_receipt"; }
${mode === 'partial-copy' ? 'cp() { local destination="${@: -1}"; command cp "$COV_TMP/unit.json" "$destination/"; return 1; }' : ''}
BACKEND_PID=""
${cleanupFunction}
trap cleanup EXIT
bash "$3/child.sh" "$COV_TMP" "$3/ready" &
BACKEND_PID=$!
for attempt in {1..200}; do
  [[ -f "$3/ready" ]] && break
  sleep 0.01
done
[[ -f "$3/ready" ]]
exit "$4"`,
        'coverage-cleanup',
        raw,
        evidence,
        fixture,
        mode === 'success' ? '0' : '7',
      ],
      { encoding: 'utf8', timeout: 10000 }
    );
    assert.equal(result.status, mode === 'success' ? 0 : 7, result.stderr);
    assert.equal(readFileSync(join(fixture, 'groups'), 'utf8'), 'disarmed\n');
    assert.equal(readFileSync(join(fixture, 'released'), 'utf8'), 'released');
    if (mode === 'failure' || mode === 'failure-before-evidence') {
      const archivedRaw = /Raw V8 coverage: (.+)/.exec(result.stdout)?.[1];
      assert.ok(archivedRaw, 'completed archival must report its recovery path');
      if (mode === 'failure') assert.equal(archivedRaw, join(evidence, 'raw-v8'));
      else assert.ok(archivedRaw.startsWith(join(fixture, '.context', 'test-runs')));
      assert.equal(readFileSync(join(archivedRaw, 'unit.json'), 'utf8'), '{"result":[]}\n');
      assert.equal(readFileSync(join(archivedRaw, '.hidden-map'), 'utf8'), 'source-map evidence');
      assert.equal(readFileSync(join(archivedRaw, 'late.json'), 'utf8'), 'late V8 flush');
      assert.equal(existsSync(raw), false, 'remove working data only after successful archival');
    } else if (mode === 'success') {
      assert.equal(existsSync(raw), false, 'successful cleanup remains unchanged');
      assert.equal(existsSync(join(evidence, 'raw-v8')), false);
    } else {
      assert.equal(readFileSync(join(raw, 'unit.json'), 'utf8'), '{"result":[]}\n');
      assert.equal(readFileSync(join(raw, 'late.json'), 'utf8'), 'late V8 flush');
      assert.match(result.stderr, /retained at/);
      const restart = spawnSync(
        'bash',
        ['-c', `set -euo pipefail\nCOV_TMP="$1"\n${tempSetup}`, 'coverage-restart', raw],
        { encoding: 'utf8' }
      );
      assert.notEqual(
        restart.status,
        0,
        'the next run must refuse to discard unrecovered raw data'
      );
      assert.equal(readFileSync(join(raw, 'unit.json'), 'utf8'), '{"result":[]}\n');
      assert.equal(readFileSync(join(raw, 'late.json'), 'utf8'), 'late V8 flush');
      if (mode === 'partial-copy') {
        assert.equal(
          existsSync(join(evidence, 'raw-v8')),
          false,
          'an incomplete copy must never be published as raw-v8'
        );
      }
      if (mode === 'existing-archive') {
        assert.equal(
          readFileSync(join(evidence, 'raw-v8', 'earlier.json'), 'utf8'),
          'earlier evidence'
        );
        assert.equal(
          existsSync(join(evidence, 'raw-v8', 'raw')),
          false,
          'never silently nest archives'
        );
      }
    }
  }
} finally {
  rmSync(cleanupRoot, { recursive: true, force: true });
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
