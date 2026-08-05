/**
 * Regression: approval SMS must never show raw markdown asterisks on iMessage,
 * and tool-approval drafts (message_person email) must keep the full message body.
 *
 * Incident: agent eab955b6 — SMS showed `**Email**` / `**To:**` literally, and the
 * Message section ended mid-sentence at "Please share the".
 */

import assert from 'node:assert/strict';

import {
  formatPaymentApprovalBody,
  stripMarkdownForSms,
} from '../../providers/smsSupervisor/writeLockBody';

const INCIDENT_APPROVAL_QUESTION = `Rose wants to send an **Email**

**To:** sr-team@a16z.com (sr-team@a16z.com)
**From:** andy@roselabs.ai
**Subject:** LLM and Cloud Credit Amounts for Speedrun Marketplace

**Intent:** Ask a16z Speedrun team (sr-team@a16z.com) for the exact breakdown and dollar amounts of LLM and cloud credits provided per provider (specifically OpenAI, Anthropic, AWS, Google Cloud, Azure, and Runpod) through the a16z Speedrun marketplace.

**Message:**
Hi Speedrun Team,

I am looking into credit allocations provided through the Speedrun marketplace for our infrastructure planning.

Please share the exact credit amounts by provider for OpenAI, Anthropic, AWS, Google Cloud, Azure, and Runpod.

Thanks,
Andy

Reply to approve, or say "no" to cancel.`;

function testStripMarkdownRemovesEmphasisMarkers(): void {
  const plain = stripMarkdownForSms('Rose wants to send an **Email**\n\n**To:** a@b.com');
  assert.equal(plain.includes('**'), false, `Expected no markdown markers, got: ${plain}`);
  assert.match(plain, /Email/);
  assert.match(plain, /To:/);
}

function testWriteLockFallbackStripsMarkdownAndKeepsFullDraft(): void {
  const agentUrl = 'https://roselabs.ai/?agent-id=eab955b6-54bd-498a-a115-632851a2bddd';
  const body = formatPaymentApprovalBody(null, null, INCIDENT_APPROVAL_QUESTION, agentUrl);

  assert.equal(body.includes('**'), false, `SMS body leaked markdown asterisks:\n${body}`);
  assert.match(body, /^Approval needed:/);
  assert.match(body, /Rose wants to send an Email/);
  assert.match(body, /To: sr-team@a16z\.com/);
  assert.match(body, /From: andy@roselabs\.ai/);
  assert.match(body, /Subject: LLM and Cloud Credit Amounts/);
  assert.match(
    body,
    /Please share the exact credit amounts by provider for OpenAI, Anthropic, AWS, Google Cloud, Azure, and Runpod\./
  );
  assert.match(body, /Thanks,\nAndy/);
  assert.match(body, /Reply to approve/);
  assert.match(body, /View agent: https:\/\/roselabs\.ai\/\?agent-id=eab955b6/);
}

function testWriteLockFallbackDoesNotTruncateLongDraft(): void {
  const longDraft = `Paragraph ${'x'.repeat(50)}\n`.repeat(40).trim();
  const question = [
    'Rose wants to send an **Email**',
    '',
    '**To:** someone@example.com (someone@example.com)',
    '**From:** andy@roselabs.ai',
    '**Subject:** Long draft',
    '',
    '**Intent:** Send a long email',
    '',
    '**Message:**',
    longDraft,
    '',
    'Reply to approve, or say "no" to cancel.',
  ].join('\n');

  const body = formatPaymentApprovalBody(
    null,
    null,
    question,
    'https://roselabs.ai/?agent-id=agent-1'
  );
  assert.equal(body.includes('**'), false, `SMS body leaked markdown asterisks:\n${body}`);
  assert.ok(body.includes(longDraft), 'Expected full draft body to survive SMS formatting');
  assert.ok(
    body.length > 900,
    `Expected long tool-approval SMS to exceed payment truncate budget, got ${body.length}`
  );
}

const cases = [
  {
    name: 'stripMarkdownForSms removes emphasis markers',
    fn: testStripMarkdownRemovesEmphasisMarkers,
  },
  {
    name: 'write_lock fallback strips markdown and keeps full draft',
    fn: testWriteLockFallbackStripsMarkdownAndKeepsFullDraft,
  },
  {
    name: 'write_lock fallback does not truncate long tool-approval drafts',
    fn: testWriteLockFallbackDoesNotTruncateLongDraft,
  },
];

let failed = 0;
for (const testCase of cases) {
  try {
    testCase.fn();
    process.stdout.write(`  PASS  ${testCase.name}\n`);
  } catch (error) {
    failed += 1;
    process.stdout.write(
      `  FAIL  ${testCase.name} -- ${error instanceof Error ? error.message : String(error)}\n`
    );
  }
}

if (failed > 0) {
  process.stderr.write(`FAIL sms-approval-plain-text (${failed}/${cases.length} failed)\n`);
  process.exit(1);
}
process.stdout.write(`PASS sms-approval-plain-text (${cases.length} cases)\n`);
