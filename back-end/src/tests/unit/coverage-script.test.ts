import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const script = readFileSync(join(process.cwd(), 'scripts', 'run-coverage.sh'), 'utf8');

assert.match(
  script,
  /lsof -tiTCP:"\$COV_PORT" -sTCP:LISTEN/,
  'coverage port preflight must ignore outbound connections using the same local port'
);

process.stdout.write('coverage script port preflight test passed\n');
