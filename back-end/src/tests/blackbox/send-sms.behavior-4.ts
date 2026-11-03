import {
  captureToken,
  createNotifyAgent,
  request,
  BASE_URL,
  apiKeyHeaders,
  TEST_USER_ID,
  assertStatus,
  readCapturesForToken,
  filterSurgeCalls,
  assert,
  TEST_PHONE,
  assertNoRoutingLeaks,
  assertAgentLinkPresent,
  prisma,
  assertOnlyAgentLinkUrl,
} from './send-sms.support';

export async function testBoundary_notifyWriteLockNaturalLanguageOnly() {
  const token = captureToken('notify-write-lock');
  const agent = await createNotifyAgent('boundary write lock agent');
  const attentionRequestId = `attn-bb-${crypto.randomUUID()}`;
  const question = 'Can I place the Amazon order for $42?';
  try {
    const res = await request(`${BASE_URL}/api/send-sms/notify`, {
      method: 'POST',
      headers: { ...apiKeyHeaders(), 'X-Capture-Token': token },
      body: JSON.stringify({
        user_id: TEST_USER_ID,
        event_type: 'write_lock',
        agent_id: agent.id,
        payload: {
          question,
          attention_request_id: attentionRequestId,
          workflow_id: 'wf-boundary-write-lock',
        },
      }),
    });
    assertStatus(res.status, 200, res.data);
    const calls = await readCapturesForToken(token);
    const surgeCalls = filterSurgeCalls(calls, question);
    if (surgeCalls.length === 0) {
      console.log('    [skipped] No Surge calls -- Surge may not be configured');
      return;
    }
    assert(surgeCalls.length === 1, `Expected 1 Surge call, got ${surgeCalls.length}`);
    const call = surgeCalls[0];
    assert(call.requestBody !== null, 'Expected non-null request body');
    const body = JSON.parse(call.requestBody!);
    assert(body.to === TEST_PHONE, `Expected to=${TEST_PHONE}`);
    assert(body.body.includes(question), `Expected write-lock question in SMS, got: ${body.body}`);
    assertNoRoutingLeaks(body.body, agent.id);
    assertAgentLinkPresent(body.body, agent.id);
    assert(
      !body.body.includes(attentionRequestId),
      `Expected no attention request id in SMS, got: ${body.body}`
    );
  } finally {
    await prisma.agent.deleteMany({ where: { id: agent.id } });
  }
}

export async function testBoundary_notifyWriteLockSendsInitialOnly() {
  const token = captureToken('notify-write-lock-initial-only');
  const agent = await createNotifyAgent('write lock initial-only agent');
  const attentionRequestId = `attn-bb-${crypto.randomUUID()}`;
  const question = 'Can I place the initial-only order for $19?';
  const notify = (reminder: boolean) =>
    request(`${BASE_URL}/api/send-sms/notify`, {
      method: 'POST',
      headers: { ...apiKeyHeaders(), 'X-Capture-Token': token },
      body: JSON.stringify({
        user_id: TEST_USER_ID,
        event_type: 'write_lock',
        agent_id: agent.id,
        payload: {
          question,
          attention_request_id: attentionRequestId,
          workflow_id: 'wf-write-lock-initial-only',
          reminder,
        },
      }),
    });
  try {
    assertStatus((await notify(false)).status, 200);
    assertStatus((await notify(false)).status, 200);
    assertStatus((await notify(true)).status, 200);
    assertStatus((await notify(true)).status, 200);
    const calls = await readCapturesForToken(token);
    const surgeCalls = filterSurgeCalls(calls, question);
    if (surgeCalls.length === 0) {
      console.log('    [skipped] No Surge calls -- Surge may not be configured');
      return;
    }
    assert(surgeCalls.length === 1, `Expected only the initial SMS, got ${surgeCalls.length}`);
    const initialBody = JSON.parse(surgeCalls[0]?.requestBody ?? '{}') as { body?: string };
    assert(
      initialBody.body?.includes(question) === true,
      `Expected initial write-lock question, got: ${initialBody.body ?? ''}`
    );
    assert(
      initialBody.body?.includes('Still waiting for your approval.') !== true,
      `Expected no reminder prefix, got: ${initialBody.body ?? ''}`
    );
  } finally {
    await prisma.toolSideEffect.deleteMany({
      where: { operationKey: { startsWith: `lifecycle-sms.write_lock:${attentionRequestId}:` } },
    });
    await prisma.agent.deleteMany({ where: { id: agent.id } });
  }
}

/**
 * message_person email approvals historically embedded Markdown (`**Email**`,
 * `**To:**`) that iMessage renders as literal asterisks, and long drafts must
 * survive the write_lock SMS formatter intact (no 900-char payment truncate).
 */
export async function testBoundary_notifyWriteLockStripsMarkdownAndKeepsFullDraft() {
  const token = captureToken('notify-write-lock-plain');
  const agent = await createNotifyAgent('boundary write lock plain-text agent');
  const attentionRequestId = `attn-bb-${crypto.randomUUID()}`;
  const fullDraft =
    'Hi Speedrun Team,\n\n' +
    'I am looking into credit allocations provided through the Speedrun marketplace ' +
    'for our infrastructure planning.\n\n' +
    'Please share the exact credit amounts by provider for OpenAI, Anthropic, AWS, ' +
    'Google Cloud, Azure, and Runpod.\n\n' +
    'Thanks,\nAndy';
  const question = [
    'Rose wants to send an **Email**',
    '',
    '**To:** sr-team@a16z.com (sr-team@a16z.com)',
    '**From:** andy@roselabs.ai',
    '**Subject:** LLM and Cloud Credit Amounts for Speedrun Marketplace',
    '',
    '**Intent:** Ask for exact LLM and cloud credit amounts',
    '',
    '**Message:**',
    fullDraft,
    '',
    'Reply to approve, or say "no" to cancel.',
  ].join('\n');
  try {
    const res = await request(`${BASE_URL}/api/send-sms/notify`, {
      method: 'POST',
      headers: { ...apiKeyHeaders(), 'X-Capture-Token': token },
      body: JSON.stringify({
        user_id: TEST_USER_ID,
        event_type: 'write_lock',
        agent_id: agent.id,
        payload: {
          question,
          attention_request_id: attentionRequestId,
          workflow_id: 'wf-boundary-write-lock-plain',
          metadata: { toolApproval: true },
        },
      }),
    });
    assertStatus(res.status, 200, res.data);
    const calls = await readCapturesForToken(token);
    const surgeCalls = filterSurgeCalls(calls, 'Please share the exact credit amounts');
    if (surgeCalls.length === 0) {
      console.log('    [skipped] No Surge calls -- Surge may not be configured');
      return;
    }
    assert(surgeCalls.length === 1, `Expected 1 Surge call, got ${surgeCalls.length}`);
    const call = surgeCalls[0];
    assert(call.requestBody !== null, 'Expected non-null request body');
    const body = JSON.parse(call.requestBody!) as { to?: string; body?: string };
    assert(body.to === TEST_PHONE, `Expected to=${TEST_PHONE}`);
    assert(typeof body.body === 'string', 'Expected SMS body string');
    assert(
      !body.body.includes('**'),
      `Expected no markdown asterisks in SMS body, got: ${body.body}`
    );
    assert(
      body.body.includes("I'm ready to send an Email"),
      `Expected plain Email label, got: ${body.body}`
    );
    assert(
      body.body.includes('To: sr-team@a16z.com'),
      `Expected plain To label, got: ${body.body}`
    );
    assert(body.body.includes(fullDraft), `Expected full draft in SMS body, got: ${body.body}`);
    assertNoRoutingLeaks(body.body, agent.id);
    assertAgentLinkPresent(body.body, agent.id);
  } finally {
    await prisma.agent.deleteMany({ where: { id: agent.id } });
  }
}

export async function testBoundary_notifyAgentCardSetupIncludesSetupLink() {
  const token = captureToken('notify-agentcard-setup');
  const agent = await createNotifyAgent('boundary agentcard setup agent');
  const setupUrl = 'https://rose.test/api/agentcard/connect?user=user-123';
  try {
    const res = await request(`${BASE_URL}/api/send-sms/notify`, {
      method: 'POST',
      headers: { ...apiKeyHeaders(), 'X-Capture-Token': token },
      body: JSON.stringify({
        user_id: TEST_USER_ID,
        event_type: 'agentcard_setup',
        agent_id: agent.id,
        payload: {
          setup_url: setupUrl,
          attention_request_id: `attn-bb-${crypto.randomUUID()}`,
          workflow_id: 'wf-agentcard-setup',
        },
      }),
    });
    assertStatus(res.status, 200, res.data);
    const calls = await readCapturesForToken(token);
    const surgeCalls = filterSurgeCalls(calls, 'one-time AgentCard setup');
    if (surgeCalls.length === 0) {
      console.log('    [skipped] No Surge calls -- Surge may not be configured');
      return;
    }
    assert(surgeCalls.length === 1, `Expected 1 Surge call, got ${surgeCalls.length}`);
    const call = surgeCalls[0];
    assert(call.requestBody !== null, 'Expected non-null request body');
    const body = JSON.parse(call.requestBody!);
    assert(body.to === TEST_PHONE, `Expected to=${TEST_PHONE}`);
    assert(
      body.body.includes('one-time AgentCard setup'),
      `Expected setup label, got: ${body.body}`
    );
    assert(body.body.includes(setupUrl), `Expected setup link in SMS, got: ${body.body}`);
    assertNoRoutingLeaks(body.body, agent.id);
  } finally {
    await prisma.agent.deleteMany({ where: { id: agent.id } });
  }
}

export async function testBoundary_notifyWriteLockStructuredMms() {
  const token = captureToken('notify-write-lock-mms');
  const agent = await createNotifyAgent('boundary write lock mms agent');
  const imageUrl =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
  const itemTitle = "Carhartt Men's Knit Cuffed Beanie, Black";
  const itemDescription = 'Soft rib-knit acrylic, fold-up cuff, Carhartt patch label.';
  try {
    const res = await request(`${BASE_URL}/api/send-sms/notify`, {
      method: 'POST',
      headers: { ...apiKeyHeaders(), 'X-Capture-Token': token },
      body: JSON.stringify({
        user_id: TEST_USER_ID,
        event_type: 'write_lock',
        agent_id: agent.id,
        payload: {
          question: 'legacy markdown question should not be the primary renderer',
          attention_request_id: `attn-bb-${crypto.randomUUID()}`,
          workflow_id: 'wf-boundary-write-lock-mms',
          metadata: {
            writeLockNotification: {
              trigger_type: 'purchase',
              action: 'Place an Amazon order for one selected black beanie',
              service: {
                name: 'Amazon',
                domain: 'amazon.com',
                url: 'https://www.amazon.com/gp/buy/spc/handlers/display.html',
              },
              media: [],
              purchase: {
                items: [
                  {
                    title: itemTitle,
                    price: '$19.99',
                    quantity: '1',
                    description: itemDescription,
                    rating: '4.8 out of 5 stars',
                    review_count: '167,432 ratings',
                    image_url: imageUrl,
                  },
                ],
                totals: { subtotal: '$19.99', tax: '$1.75', total: '$21.74' },
              },
            },
          },
        },
      }),
    });
    assertStatus(res.status, 200, res.data);
    const calls = await readCapturesForToken(token);
    const surgeCalls = filterSurgeCalls(calls, itemTitle);
    if (surgeCalls.length === 0) {
      console.log('    [skipped] No Surge calls -- Surge may not be configured');
      return;
    }
    assert(surgeCalls.length === 1, `Expected 1 Surge call, got ${surgeCalls.length}`);
    const call = surgeCalls[0];
    assert(call.requestBody !== null, 'Expected non-null request body');
    const body = JSON.parse(call.requestBody!) as {
      to?: string;
      body?: string;
      attachments?: { url?: string }[];
    };
    assert(body.to === TEST_PHONE, `Expected to=${TEST_PHONE}`);
    assert(
      body.body?.includes('I need your approval to check out at Amazon.') === true,
      `Expected carrier-safe checkout approval copy: ${body.body}`
    );
    assert(
      body.body?.includes(`Description: ${itemDescription}`) === true,
      `Expected renderer to preserve the LLM-provided description: ${body.body}`
    );
    assert(body.body?.includes(itemTitle) === true, `Expected item title in MMS: ${body.body}`);
    assert(body.body?.includes('Price: $19.99') === true, `Expected price in MMS: ${body.body}`);
    assert(
      body.body?.includes('Rating: 4.8 out of 5 stars') === true,
      `Expected rating: ${body.body}`
    );
    assert(body.body?.includes('Total: $21.74') === true, `Expected total in MMS: ${body.body}`);
    assert(!body.body?.includes('Page:'), `Expected no page URL in carrier SMS body: ${body.body}`);
    // The per-agent deep link is the only URL allowed to survive; the merchant
    // product/checkout URLs must still be stripped for carrier deliverability.
    assertOnlyAgentLinkUrl(body.body ?? '', agent.id);
    assert(
      !/\bAmazon\.com\b/i.test(body.body ?? ''),
      `Expected no bare domain in SMS body: ${body.body}`
    );
    assert(
      Array.isArray(body.attachments) &&
        typeof body.attachments[0]?.url === 'string' &&
        body.attachments[0].url !== imageUrl,
      `Expected rehosted MMS attachment, got: ${JSON.stringify(body.attachments)}`
    );
    assertNoRoutingLeaks(body.body ?? '', agent.id);
  } finally {
    await prisma.agent.deleteMany({ where: { id: agent.id } });
  }
}

/**
 * Return / generic_write write locks must SMS Action/Target/Change — not the
 * purchase-only "checkout" stub that dropped refund and drop-off details.
 */
export async function testBoundary_notifyWriteLockGenericWriteReturn() {
  const token = captureToken('notify-write-lock-return');
  const agent = await createNotifyAgent('boundary write lock return agent');
  const itemTitle = 'Carhartt Mens Knit Cuffed Beanie Hat, Black, One Size US';
  const change =
    'Refund $10.84 to original payment method via Whole Foods Dropoff. Return by Sep 19, 2026.';
  try {
    const res = await request(`${BASE_URL}/api/send-sms/notify`, {
      method: 'POST',
      headers: { ...apiKeyHeaders(), 'X-Capture-Token': token },
      body: JSON.stringify({
        user_id: TEST_USER_ID,
        event_type: 'write_lock',
        agent_id: agent.id,
        payload: {
          question: 'legacy markdown question should not be primary for return SMS',
          attention_request_id: `attn-bb-${crypto.randomUUID()}`,
          workflow_id: 'wf-boundary-write-lock-return',
          metadata: {
            writeLockNotification: {
              trigger_type: 'generic_write',
              action: 'confirm Amazon return for Carhartt beanie',
              service: {
                name: 'Amazon',
                domain: 'amazon.com',
                url: 'https://www.amazon.com/spr/returns/contract/example',
              },
              media: [],
              generic_write: {
                label: 'Confirm return',
                target: itemTitle,
                payload_summary: change,
              },
            },
          },
        },
      }),
    });
    assertStatus(res.status, 200, res.data);
    const calls = await readCapturesForToken(token);
    const surgeCalls = filterSurgeCalls(calls, 'Confirm return');
    if (surgeCalls.length === 0) {
      console.log('    [skipped] No Surge calls -- Surge may not be configured');
      return;
    }
    assert(surgeCalls.length === 1, `Expected 1 Surge call, got ${surgeCalls.length}`);
    const call = surgeCalls[0];
    assert(call.requestBody !== null, 'Expected non-null request body');
    const body = JSON.parse(call.requestBody!) as { to?: string; body?: string };
    assert(body.to === TEST_PHONE, `Expected to=${TEST_PHONE}`);
    const text = body.body ?? '';
    assert(
      text.includes('I need your approval to confirm Amazon return for Carhartt beanie on Amazon.'),
      `Expected return action header: ${text}`
    );
    assert(!/checkout/i.test(text), `Expected no purchase checkout wording: ${text}`);
    assert(text.includes('Action: Confirm return'), `Expected Action label: ${text}`);
    assert(text.includes(`Target: ${itemTitle}`), `Expected Target: ${text}`);
    assert(text.includes(`Change: ${change}`), `Expected Change: ${text}`);
    assertOnlyAgentLinkUrl(text, agent.id);
    assertNoRoutingLeaks(text, agent.id);
  } finally {
    await prisma.agent.deleteMany({ where: { id: agent.id } });
  }
}
