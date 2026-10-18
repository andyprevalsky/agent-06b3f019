import assert from 'node:assert/strict';

import { getAgentUrl, SMS_TEMPLATES } from '../../providers/smsTemplates';
import { formatPaymentApprovalBody } from '../../providers/smsSupervisor/writeLockBody';

const agentUrl = 'https://roselabs.ai/?agent-id=coffee-123';

const phoneAttentionUrl = new URL(getAgentUrl('phone-agent', 'phone-task', 'phone-request'));
assert.equal(phoneAttentionUrl.origin, 'https://roselabs.ai');
assert.equal(phoneAttentionUrl.searchParams.get('agent-id'), 'phone-agent');
assert.equal(phoneAttentionUrl.searchParams.get('browser-id'), 'phone-task');
assert.equal(phoneAttentionUrl.searchParams.get('attention-request-id'), 'phone-request');
assert.equal(
  new URL(getAgentUrl('browser-agent', 'browser-task')).searchParams.has('attention-request-id'),
  false
);

assert.equal(
  SMS_TEMPLATES.agentStarted('coffee', 'Order my usual Blue Bottle coffee for pickup', agentUrl),
  `I'm on it: Order my usual Blue Bottle coffee for pickup\nFollow along: ${agentUrl}`
);
assert.equal(
  SMS_TEMPLATES.agentStarted(
    'coffee',
    'INTERNAL: use saved account details and compare pickup locations',
    agentUrl,
    "I'll order your usual Blue Bottle coffee."
  ),
  `I'll order your usual Blue Bottle coffee.\n${agentUrl}`
);
assert.equal(
  SMS_TEMPLATES.plannerQuestion('coffee', 'Which Blue Bottle location should I use?'),
  'I need your input to keep going: Which Blue Bottle location should I use?'
);
assert.equal(
  SMS_TEMPLATES.plannerFyi('coffee', 'The Ferry Building location opens at 7 AM.'),
  "Here's an update: The Ferry Building location opens at 7 AM."
);
assert.equal(
  SMS_TEMPLATES.writeLock('coffee', 'Can I place the $11.25 order?'),
  'I need your approval before I continue:\nCan I place the $11.25 order?'
);
assert.equal(
  SMS_TEMPLATES.authAssistance('coffee', 'Blue Bottle', agentUrl),
  `I need you to sign in to Blue Bottle so I can continue.\nSign in here: ${agentUrl}`
);
assert.equal(
  SMS_TEMPLATES.agentCardSetup('coffee', 'https://roselabs.ai/agentcard/setup'),
  'I need you to finish your one-time AgentCard setup before I can pay for this.\nSet it up: https://roselabs.ai/agentcard/setup'
);
assert.equal(
  SMS_TEMPLATES.agentCompleted(
    'coffee',
    'Your Blue Bottle order is confirmed for pickup at 7:40 AM.',
    agentUrl,
    ['Order Total: $11.25']
  ),
  `I finished the task: Your Blue Bottle order is confirmed for pickup at 7:40 AM.\nOrder Total: $11.25\nSee the details: ${agentUrl}`
);
assert.equal(
  SMS_TEMPLATES.costLimit('coffee', 'Find four tickets for Friday', 500, 500),
  `I've paused "Find four tickets for Friday" at the $5.00 budget limit. Reply with the amount you'd like to add, and I'll keep going.`
);

const approval = formatPaymentApprovalBody(
  null,
  {
    trigger_type: 'message',
    action: 'send email',
    service: { name: 'Gmail' },
    message: { to: ['alex@example.com'], subject: 'Dinner Friday', body: 'How about 7 PM?' },
  },
  'unused',
  agentUrl
);
assert.match(approval, /^I need your approval to send email on Gmail\./);
assert.match(approval, /To: alex@example\.com/);
assert.match(approval, /How about 7 PM\?/);
assert.ok(approval.endsWith(`Review in Rose: ${agentUrl}`));

process.stdout.write('PASS sms-lifecycle-copy\n');
