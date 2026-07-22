import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const coverageScript = readFileSync(join(process.cwd(), 'scripts', 'run-coverage.sh'), 'utf8');
const blackboxScript = readFileSync(
  join(process.cwd(), 'scripts', 'run-blackbox-tests.sh'),
  'utf8'
);
const blackboxRunner = readFileSync(
  join(process.cwd(), 'src', 'tests', 'blackbox', 'run.ts'),
  'utf8'
);
const unitRunner = readFileSync(join(process.cwd(), 'scripts', 'run-unit-tests.ts'), 'utf8');
const adminHealthBlackbox = readFileSync(
  join(process.cwd(), 'src', 'tests', 'blackbox', 'admin-health.blackbox.ts'),
  'utf8'
);

assert.match(
  coverageScript,
  /lsof -tiTCP:"\$COV_PORT" -sTCP:LISTEN/,
  'coverage port preflight must ignore outbound connections using the same local port'
);
assert.match(
  coverageScript,
  /export AMPLITUDE_API_KEY=""[\s\S]*export AMPLITUDE_SECRET_KEY=""/,
  'coverage must isolate external analytics from deterministic instrumentation'
);
assert.match(
  adminHealthBlackbox,
  /ADMIN_HEALTH_LIVE_ONLY[\s\S]*await runPool\(\[strictLiveTests\[2\]\], 1\)/,
  'the focused live stage must retain the strict weekly endpoint assertion'
);
assert.match(
  coverageScript,
  /READINESS_STARTED_AT=\$SECONDS/,
  'coverage readiness must measure a wall-clock start time'
);
assert.match(
  coverageScript,
  /READINESS_DEADLINE=\$\(\(READINESS_STARTED_AT \+ 300\)\)/,
  'coverage readiness must use the five-minute deadline ceiling'
);
assert.match(
  coverageScript,
  /REMAINING_READINESS_SECONDS=\$\(\(READINESS_DEADLINE - SECONDS\)\)/,
  'coverage readiness must compute the actual time remaining'
);
assert.match(
  coverageScript,
  /curl -fsS -m "\$CURL_TIMEOUT_SECONDS"/,
  'coverage readiness must clip each health request to its remaining deadline'
);
assert.doesNotMatch(
  coverageScript,
  /for attempt in \$\(seq 1 600\)/,
  'coverage readiness must not use a fixed attempt-count timeout'
);
assert.match(
  coverageScript,
  /bash scripts\/run-blackbox-tests\.sh &[\s\S]*node --import tsx scripts\/run-unit-tests\.ts &/,
  'backend blackbox and isolated unit pools must overlap under coverage'
);
assert.match(
  coverageScript,
  /BLACKBOX_ADMIN_HEALTH_LIVE_AMPLITUDE_SLICES="\$\{BLACKBOX_ADMIN_HEALTH_LIVE_AMPLITUDE_SLICES:-weekly\}"/,
  'coverage must reserve the live Amplitude budget for the strict weekly assertion'
);
assert.match(
  blackboxScript,
  /BLACKBOX_TEST_CAPTURE_OUTBOUND="\$\{BLACKBOX_TEST_CAPTURE_OUTBOUND:-1\}"/,
  'blackbox runs must activate the configured live-slice filter by default'
);
assert.match(
  blackboxRunner,
  /spawn\(process\.execPath, \['--import', 'tsx', file\]/,
  'blackbox domains must avoid npm and tsx wrapper processes under V8 coverage'
);
assert.match(
  unitRunner,
  /spawn\(process\.execPath, \['--import', 'tsx', file\]/,
  'unit files must avoid npm and tsx wrapper processes under V8 coverage'
);
assert.match(
  unitRunner,
  /BACKEND_UNIT_CONCURRENCY/,
  'unit runner must expose its bounded process-pool size'
);
assert.match(
  unitRunner,
  /if \(interrupted\) process\.exit\(130\);[\s\S]*const failures = results\.filter/,
  'unit runner must report interruption before killed children as failures'
);
assert.match(
  unitRunner,
  /fileLabel\.replace\(\/\\\.test\\\.ts\$\/, '\.log'\)[\s\S]*mkdir\(dirname\(logPath\)/,
  'unit logs must preserve nested paths instead of colliding on basenames'
);
assert.match(
  coverageScript,
  /BACKEND_UNIT_COVERAGE_DIR="\$COV_TMP"[\s\S]*node --import tsx scripts\/run-unit-tests\.ts &/,
  'coverage must be passed to unit children without instrumenting the scheduler itself'
);
assert.match(
  unitRunner,
  /NODE_V8_COVERAGE: coverageDir/,
  'every isolated unit child must retain V8 coverage instrumentation'
);
assert.ok(
  blackboxRunner.indexOf('runWithConcurrency(parallelDomains') <
    blackboxRunner.indexOf('runWithConcurrency(lateExclusiveDomains'),
  'aggregate blackbox domains must run after parallel fixture writers'
);
assert.match(
  blackboxRunner,
  /lateExclusiveDomainNames = new Set\(\['admin-health', 'benchmarks-test-prompts'\]\)/,
  'whole-database and mutable-catalog readers must be isolated from fixture writers'
);
assert.match(
  blackboxRunner,
  /domainWeights[\s\S]*\.sort\(/,
  'parallel blackbox domains must schedule measured long poles first'
);
assert.match(
  blackboxRunner,
  /\['benchmarks-hub-pipeline', 90\]/,
  'deadline-sensitive Hub lifecycle must start in the first parallel wave'
);
assert.match(
  coverageScript,
  /export FAST_MODE_CACHE_DATABASE_URL="\$LOCAL_DB_URL"/,
  'coverage must isolate Fast Mode cache fixtures in the local test database'
);
assert.doesNotMatch(
  coverageScript,
  /ENV_DATABASE_URL=.*DATABASE_URL/,
  'coverage must not derive its Fast Mode cache database from the production .env'
);
assert.match(
  coverageScript,
  /export AMPLITUDE_API_KEY=""\s+export AMPLITUDE_SECRET_KEY=""/,
  'coverage must not consume the live Amplitude chart-query budget'
);

for (const [name, harness] of [
  ['coverage', coverageScript],
  ['blackbox', blackboxScript],
] as const) {
  assert.match(
    harness,
    /BACKEND_CODEX_TOKEN_SYNC_SKIP/,
    `${name} harness must support preserving pre-seeded Codex credentials`
  );
  assert.doesNotMatch(
    harness,
    /if \[\[ "\$\{BACKEND_CODEX_SMOKE_SKIP:-0\}" != "1" \]\]; then\s+echo "Syncing local Codex credentials/,
    `${name} harness must not couple credential sync to live-smoke execution`
  );
  assert.match(
    harness,
    /CODEX_AUTH_MODE=.*auth_mode/,
    `${name} harness must inspect the local Codex auth mode before importing it`
  );
  assert.match(
    harness,
    /SEEDED_CODEX_COUNT=.*Integration.*gpt_code/s,
    `${name} harness must preserve a connected isolated gpt_code credential when local auth is incompatible`
  );
}

assert.match(
  blackboxScript,
  /FAST_MODE_ANTHROPIC_PROXY_URL="\$\{BLACKBOX_FAST_MODE_ANTHROPIC_PROXY_URL:-\}"/,
  'isolated blackbox backend must not inherit a developer Fast Mode Anthropic tunnel'
);
assert.match(
  blackboxScript,
  /FAST_MODE_CODEX_PROXY_URL="\$\{BLACKBOX_FAST_MODE_CODEX_PROXY_URL:-\}"/,
  'isolated blackbox backend must not inherit a developer Fast Mode Codex tunnel'
);

process.stdout.write('coverage script contracts passed\n');
