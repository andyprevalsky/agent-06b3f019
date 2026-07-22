import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const healthCheck = readFileSync(
  join(process.cwd(), 'src', 'tests', 'blackbox', 'integration-health.blackbox.ts'),
  'utf8'
);

assert.match(
  healthCheck,
  /https:\/\/api\.anthropic\.com\/v1\/messages/,
  'Anthropic health must exercise a billable completion, not an auth-only endpoint'
);
assert.doesNotMatch(
  healthCheck,
  /https:\/\/api\.anthropic\.com\/v1\/models/,
  'Anthropic model listing does not prove that the account has usable credits'
);
assert.match(
  healthCheck,
  /max_tokens:\s*1/,
  'Anthropic completion health must cap the probe at one output token'
);
assert.match(
  healthCheck,
  /credit balance is too low\|out of credits\|purchase credits/i,
  'Anthropic health must recognize the captured HTTP 400 billing response'
);
assert.match(
  healthCheck,
  /console\.anthropic\.com\/settings\/billing/,
  'Anthropic billing failure must direct the operator to the billing page'
);

process.stdout.write('integration health contracts passed\n');
