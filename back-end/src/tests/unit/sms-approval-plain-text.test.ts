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

const AGENT_URL = 'https://roselabs.ai/?agent-id=demo';

function testGenericWriteReturnSmsIncludesRefundDetails(): void {
  const notification = {
    trigger_type: 'generic_write',
    action: 'confirm Amazon return for Carhartt beanie',
    service: { name: 'Amazon', domain: 'amazon.com' },
    media: [{ url: 'https://m.media-amazon.com/images/I/beanie.jpg', kind: 'product' }],
    generic_write: {
      label: 'Confirm return',
      target: 'Carhartt Mens Knit Cuffed Beanie Hat, Black, One Size US',
      payload_summary:
        'Refund $10.84 to original payment method via Whole Foods Dropoff. Return by Sep 19, 2026.',
    },
  };
  const body = formatPaymentApprovalBody(
    null,
    notification,
    'fallback question should not be used when generic_write is populated',
    AGENT_URL
  );

  assert.match(body, /^Approval needed\n/);
  assert.match(body, /Rose wants to confirm Amazon return for Carhartt beanie on Amazon\./);
  assert.doesNotMatch(body, /checkout/i);
  assert.match(body, /Action: Confirm return/);
  assert.match(body, /Target: Carhartt Mens Knit Cuffed Beanie Hat/);
  assert.match(body, /Change: Refund \$10\.84 to original payment method via Whole Foods Dropoff/);
  assert.match(body, /View agent: https:\/\/roselabs\.ai\/\?agent-id=demo/);
}

function testMessageSmsIncludesRecipientsSubjectAndBody(): void {
  const notification = {
    trigger_type: 'message',
    action: 'send email',
    service: { name: 'Gmail', domain: 'mail.google.com' },
    message: {
      to: ['alex@example.com'],
      cc: [],
      bcc: [],
      subject: 'Dinner Friday',
      body: 'Want to grab dinner Friday at 7?',
    },
  };
  const body = formatPaymentApprovalBody(null, notification, 'unused', AGENT_URL);
  assert.match(body, /Rose wants to send email on Gmail\./);
  assert.doesNotMatch(body, /checkout/i);
  assert.match(body, /To: alex@example\.com/);
  assert.match(body, /Subject: Dinner Friday/);
  assert.match(body, /Want to grab dinner Friday at 7\?/);
}

function testSocialPostSmsIncludesAudienceAndBody(): void {
  const notification = {
    trigger_type: 'social_post',
    action: 'post publicly',
    service: { name: 'X', domain: 'x.com' },
    social_post: {
      destination: 'your profile',
      audience: 'Public',
      body: 'Shipped the v1 release today.',
    },
  };
  const body = formatPaymentApprovalBody(null, notification, 'unused', AGENT_URL);
  assert.match(body, /Rose wants to post publicly on X\./);
  assert.doesNotMatch(body, /checkout/i);
  assert.match(body, /Destination: your profile/);
  assert.match(body, /Audience: Public/);
  assert.match(body, /Shipped the v1 release today\./);
}

function testPaymentFieldSmsIncludesMerchantWithoutSecretsBanner(): void {
  const notification = {
    trigger_type: 'payment',
    action: 'enter payment details',
    service: { name: 'Delta', domain: 'delta.com' },
    payment: {
      merchant: 'Delta Air Lines',
      amount: '$412.30',
      purpose: 'Flight SFO -> JFK',
      fields: ['card number', 'expiration date', 'CVV'],
    },
  };
  const body = formatPaymentApprovalBody(null, notification, 'unused', AGENT_URL);
  assert.match(body, /Rose wants to enter payment details on Delta\./);
  assert.doesNotMatch(body, /checkout/i);
  assert.match(body, /Merchant: Delta Air Lines/);
  assert.match(body, /Amount: \$412\.30/);
  assert.match(body, /Purpose: Flight SFO -> JFK/);
  assert.match(body, /Fields: card number, expiration date, CVV/);
  assert.match(body, /Payment secrets are not included in this message\./);
}

function testPurchaseSmsKeepsCarrierSafeCheckoutHeader(): void {
  const notification = {
    trigger_type: 'purchase',
    action: 'buy one black Carhartt beanie',
    service: { name: 'Amazon', domain: 'amazon.com' },
    purchase: {
      items: [
        {
          title: 'Carhartt Mens Knit Cuffed Beanie Hat, Black',
          price: '$19.99',
          quantity: '1',
          description: 'Black, One Size',
          rating: '4.8 stars',
          review_count: '167,432 reviews',
        },
      ],
      totals: { subtotal: '$19.99', tax: '$1.72', total: '$21.71' },
    },
  };
  const body = formatPaymentApprovalBody(null, notification, 'unused', AGENT_URL);
  assert.match(body, /Rose needs your approval for Amazon checkout\./);
  assert.match(body, /Item: Carhartt Mens Knit Cuffed Beanie Hat, Black/);
  assert.match(body, /Total: \$21\.71/);
}

function testSparseNotificationFallsBackToRenderedQuestion(): void {
  const notification = {
    trigger_type: 'generic_write',
    action: 'confirm return',
    service: { name: 'Amazon', domain: 'amazon.com' },
    generic_write: null,
  };
  const question =
    '**Approval Needed**\n\nRose wants to confirm return on **Amazon**.\nAction: Confirm return\nTarget: Beanie';
  const body = formatPaymentApprovalBody(null, notification as never, question, AGENT_URL);
  assert.match(body, /^Approval needed:/);
  assert.match(body, /Rose wants to confirm return on Amazon/);
  assert.match(body, /Action: Confirm return/);
  assert.match(body, /Target: Beanie/);
  assert.equal(body.includes('**'), false);
}

function testSanitizeSmsTextPreservesEmailAddresses(): void {
  const body = formatPaymentApprovalBody(
    null,
    {
      trigger_type: 'message',
      action: 'send email',
      service: { name: 'Gmail', domain: 'mail.google.com' },
      message: {
        to: ['sr-team@a16z.com'],
        subject: 'Credits',
        body: 'Please reply to andy@roselabs.ai',
      },
    },
    'unused',
    AGENT_URL
  );
  assert.match(body, /To: sr-team@a16z\.com/);
  assert.match(body, /andy@roselabs\.ai/);
  assert.doesNotMatch(body, /sr-team@A16z/);
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
  {
    name: 'generic_write return SMS includes refund / drop-off details',
    fn: testGenericWriteReturnSmsIncludesRefundDetails,
  },
  {
    name: 'message SMS includes recipients subject and body',
    fn: testMessageSmsIncludesRecipientsSubjectAndBody,
  },
  {
    name: 'social_post SMS includes audience and body',
    fn: testSocialPostSmsIncludesAudienceAndBody,
  },
  {
    name: 'payment SMS includes merchant without secrets banner',
    fn: testPaymentFieldSmsIncludesMerchantWithoutSecretsBanner,
  },
  {
    name: 'purchase SMS keeps carrier-safe checkout header',
    fn: testPurchaseSmsKeepsCarrierSafeCheckoutHeader,
  },
  {
    name: 'sparse notification falls back to rendered question',
    fn: testSparseNotificationFallsBackToRenderedQuestion,
  },
  {
    name: 'sanitizeSmsText preserves email addresses in message SMS',
    fn: testSanitizeSmsTextPreservesEmailAddresses,
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
