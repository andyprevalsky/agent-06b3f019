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

process.stdout.write('coverage script contracts passed\n');
