import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// The module-loader fakes live in an owned subprocess, not the shared unit runner.
execFileSync(
  process.execPath,
  [
    '--import',
    'tsx',
    join(__dirname, '../../../scripts/fixtures/tilion-inplace-response.fixture.cjs'),
  ],
  { stdio: 'inherit' }
);
