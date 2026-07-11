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

for (const script of [coverageScript, blackboxScript]) {
  assert.match(
    script,
    /BACKEND_CODEX_TOKEN_SYNC_SKIP/,
    'test runners must allow an already-seeded Codex credential without skipping its smoke test'
  );
}

process.stdout.write('coverage script contracts passed\n');
