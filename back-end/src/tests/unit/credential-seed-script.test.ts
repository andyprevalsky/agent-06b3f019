#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const script = readFileSync(
  path.resolve(__dirname, '../../../scripts/seed-claude-code-token-from-keychain.ts'),
  'utf8'
);

assert.match(script, /name:\s*'claude_code'/, 'the keychain seed must upsert Claude credentials');
assert.doesNotMatch(
  script,
  /deleteMany|name:\s*'gpt_code'/,
  'seeding Claude credentials must preserve every other compute provider'
);

process.stdout.write('credential-seed-script: provider-preservation contract passed\n');
