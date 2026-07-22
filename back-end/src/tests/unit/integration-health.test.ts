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
assert.match(
  healthCheck,
  /DEPLOY_GATE_OVERRIDES/,
  'credential health must expose the audited deploy-gate override channel'
);
assert.match(
  healthCheck,
  /credential-health:anthropic/,
  'Anthropic override must be provider-specific rather than disabling all credential checks'
);
assert.match(
  healthCheck,
  /name:\s*'Anthropic \(Claude API\)'[\s\S]*?warnOnly:\s*true/,
  'Anthropic/Claude credential health must be non-blocking so future deploys can skip it without user approval'
);
assert.match(
  healthCheck,
  /explicitly overridden by DEPLOY_GATE_OVERRIDES/,
  'credential health output must disclose rather than conceal an override'
);

process.stdout.write('integration health contracts passed\n');
