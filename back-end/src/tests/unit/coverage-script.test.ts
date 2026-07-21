import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const coverageScript = readFileSync(join(process.cwd(), 'scripts', 'run-coverage.sh'), 'utf8');
const blackboxScript = readFileSync(
  join(process.cwd(), 'scripts', 'run-blackbox-tests.sh'),
  'utf8'
);

assert.match(
  coverageScript,
  /lsof -tiTCP:"\$COV_PORT" -sTCP:LISTEN/,
  'coverage port preflight must ignore outbound connections using the same local port'
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
