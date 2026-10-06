import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(__dirname, '../../../..');

function requireText(haystack: string, needle: string, label: string) {
  assert.ok(haystack.includes(needle), label);
}

const lifecycleSource = readFileSync(
  resolve(repoRoot, 'back-end/src/domains/agents/agentLifecycleService.ts'),
  'utf8'
);
const batchSource = readFileSync(
  resolve(repoRoot, 'back-end/src/domains/agents/agentBatchParentFlags.ts'),
  'utf8'
);
const smsQueueSource = readFileSync(
  resolve(repoRoot, 'back-end/src/providers/smsQueue.ts'),
  'utf8'
);
const whatsappCloudSource = readFileSync(
  resolve(repoRoot, 'back-end/src/providers/whatsappCloud.ts'),
  'utf8'
);
const agentPhoneServiceSource = readFileSync(
  resolve(repoRoot, 'back-end/src/domains/agent-phone/service.ts'),
  'utf8'
);
const twilioServiceSource = readFileSync(
  resolve(repoRoot, 'back-end/src/domains/auth/service.twilio.ts'),
  'utf8'
);
const runSh = readFileSync(resolve(repoRoot, 'scripts/run.sh'), 'utf8');

requireText(
  lifecycleSource,
  'parent?.isBenchmark === true',
  'sub-agents must inherit isBenchmark from benchmark parents'
);
requireText(
  batchSource,
  'inheritsBenchmarkFromBatchParent',
  'batch spawn must inherit benchmark flag from parent'
);
requireText(
  smsQueueSource,
  "shouldMockMessagingSend('surge'",
  'Surge transport must consult the live-messaging mock gate'
);
requireText(
  whatsappCloudSource,
  "shouldMockMessagingSend('whatsapp'",
  'WhatsApp transport must consult the live-messaging mock gate'
);
requireText(
  agentPhoneServiceSource,
  "shouldMockMessagingSend('agentphone'",
  'AgentPhone transport must consult the live-messaging mock gate'
);
requireText(
  twilioServiceSource,
  "shouldMockMessagingSend('twilio-verify')",
  'Twilio Verify OTP send must consult the live-messaging mock gate'
);
requireText(runSh, 'BLACKBOX_TEST_FAKE_AGENTPHONE', 'benchmark stacks must fake AgentPhone sends');
requireText(runSh, 'BLACKBOX_TEST_FAKE_WHATSAPP', 'benchmark stacks must fake WhatsApp sends');

process.stdout.write('benchmark-sms-guards: 7 passed, 0 failed\n');
