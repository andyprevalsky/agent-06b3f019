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
  assertOnlyAgentLinkUrl,
  assertNoRoutingLeaks,
  prisma,
} from './send-sms.support';

/**
 * write_lock with a requestPaymentCard payload (the normalized, always-populated
 * source) must render merchant, rating, reviews, and cost totals plus the agent
 * deep link — even when writeLockNotification is absent. This is the fix for
 * payment-approval SMS silently dropping reviews/costs.
 */
export async function testBoundary_notifyWriteLockPaymentCardEnriched() {
  const token = captureToken('notify-write-lock-card');
  const agent = await createNotifyAgent('boundary payment card agent');
  const itemName = 'Handmade Ceramic Pour-Over Dripper';
  try {
    const res = await request(`${BASE_URL}/api/send-sms/notify`, {
      method: 'POST',
      headers: { ...apiKeyHeaders(), 'X-Capture-Token': token },
      body: JSON.stringify({
        user_id: TEST_USER_ID,
        event_type: 'write_lock',
        agent_id: agent.id,
        payload: {
          question: 'Approve a $56.24 purchase?',
          attention_request_id: `attn-bb-${crypto.randomUUID()}`,
          workflow_id: 'wf-boundary-write-lock-card',
          metadata: {
            requestPaymentCard: {
              merchant: 'Nopa Fish',
              currency: 'USD',
              lineItems: [
                {
                  name: itemName,
                  productUrl: 'https://shop.example.com/dripper?ref=agent',
                  imageUrl: '',
                  rating: 4.7,
                  reviewCount: '1,284',
                  unitPriceCents: 4999,
                  quantity: 1,
                  lineTotalCents: 4999,
                },
              ],
              fees: [{ label: 'Tax', amountCents: 625 }],
              subtotalCents: 4999,
              totalCents: 5624,
            },
          },
        },
      }),
    });
    assertStatus(res.status, 200, res.data);
    const calls = await readCapturesForToken(token);
    const surgeCalls = filterSurgeCalls(calls, itemName);
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
      text.includes('I need your approval to check out at Nopa Fish.'),
      `Expected merchant in payment-card SMS: ${text}`
    );
    assert(text.includes(itemName), `Expected item name: ${text}`);
    assert(text.includes('Price: $49.99'), `Expected line price: ${text}`);
    assert(text.includes('Rating: 4.7'), `Expected rating from card: ${text}`);
    assert(text.includes('Reviews: 1,284'), `Expected review count from card: ${text}`);
    assert(text.includes('Subtotal: $49.99'), `Expected subtotal: ${text}`);
    assert(text.includes('Tax: $6.25'), `Expected fee line: ${text}`);
    assert(text.includes('Total: $56.24'), `Expected total: ${text}`);
    // Deep link present; merchant product URL stripped.
    assertOnlyAgentLinkUrl(text, agent.id);
    assertNoRoutingLeaks(text, agent.id);
  } finally {
    await prisma.agent.deleteMany({ where: { id: agent.id } });
  }
}

/**
 * Benchmark/eval runs create real root agents under the operator's own phone.
 * The dispatcher must suppress ALL lifecycle SMS for them (Agent.isBenchmark)
 * so relaxing the workflow-side source guards never texts the operator during
 * benchmark runs. Completion responses may include a rendered preview for evals.
 */
export async function testBoundary_notifyAgentStartedSuppressedForBenchmark() {
  const token = captureToken('notify-started-benchmark');
  const goal = 'boundary benchmark suppressed goal';
  const agent = await prisma.agent.create({
    data: {
      userId: TEST_USER_ID,
      goal,
      status: 'ACTIVE',
      source: 'WEB',
      progress: 0.25,
      isBenchmark: true,
    },
  });
  try {
    const res = await request(`${BASE_URL}/api/send-sms/notify`, {
      method: 'POST',
      headers: { ...apiKeyHeaders(), 'X-Capture-Token': token },
      body: JSON.stringify({
        user_id: TEST_USER_ID,
        event_type: 'agent_started',
        agent_id: agent.id,
        payload: { goal },
      }),
    });
    assertStatus(res.status, 200, res.data);
    const result = res.data as { success?: boolean; skipped?: boolean; reason?: string };
    assert(
      result.skipped === true,
      `Expected benchmark SMS to be skipped, got: ${JSON.stringify(result)}`
    );
    assert(
      result.reason === 'benchmark_agent',
      `Expected reason=benchmark_agent, got: ${JSON.stringify(result)}`
    );
    const calls = await readCapturesForToken(token);
    const surgeCalls = filterSurgeCalls(calls, goal);
    assert(
      surgeCalls.length === 0,
      `Expected NO Surge call for benchmark agent, got ${surgeCalls.length}`
    );
  } finally {
    await prisma.agent.deleteMany({ where: { id: agent.id } });
  }
}

export async function testBoundary_notifyCompletionPreviewForBenchmark() {
  const token = captureToken('notify-completion-benchmark');
  const summary = 'Blue Bottle order was completed\nwith the requested pickup configuration.';
  const outputs = Array.from({ length: 7 }, (_, index) => ({
    key: `output_${String(index + 1)}`,
    label: `Output ${String(index + 1)}`,
    value: `value ${String(index + 1)}`,
  }));
  const agent = await prisma.agent.create({
    data: {
      userId: TEST_USER_ID,
      goal: 'benchmark completion preview',
      status: 'ACTIVE',
      source: 'WEB',
      progress: 0.25,
      isBenchmark: true,
    },
  });
  try {
    const res = await request(`${BASE_URL}/api/send-sms/notify`, {
      method: 'POST',
      headers: { ...apiKeyHeaders(), 'X-Capture-Token': token },
      body: JSON.stringify({
        user_id: TEST_USER_ID,
        event_type: 'completion',
        agent_id: agent.id,
        payload: { summary, outputs },
      }),
    });
    assertStatus(res.status, 200, res.data);
    const result = res.data as {
      skipped?: boolean;
      reason?: string;
      messagePreview?: string;
    };
    assert(result.skipped === true, `Expected benchmark completion to be skipped`);
    assert(result.reason === 'benchmark_agent', `Expected benchmark_agent suppression`);
    const lines = result.messagePreview?.split('\n') ?? [];
    assert(lines.length === 8, `Expected an 8-line completion preview, got ${lines.length}`);
    assert(
      lines[0] ===
        'I finished the task: Blue Bottle order was completed with the requested pickup configuration.',
      `Expected normalized completion summary, got: ${lines[0] ?? ''}`
    );
    for (let index = 1; index <= 6; index += 1) {
      assert(
        lines[index] === `Output ${String(index)}: value ${String(index)}`,
        `Expected output ${String(index)} in preview, got: ${lines[index] ?? ''}`
      );
    }
    assert(
      lines[7]?.includes(`agent-id=${agent.id}`) === true,
      `Expected root agent link in completion preview`
    );
    assert(
      !result.messagePreview?.includes('Output 7:'),
      `Expected completion preview to truncate outputs at 8 total lines`
    );
    const calls = await readCapturesForToken(token);
    const surgeCalls = filterSurgeCalls(calls, summary);
    assert(surgeCalls.length === 0, `Expected no Surge call for benchmark completion`);
  } finally {
    await prisma.agent.deleteMany({ where: { id: agent.id } });
  }
}

/** POST /api/send-sms validation failure -> 0 outbound calls. */
export async function testBoundary_sendValidationNoOutbound() {
  const marker = 'send-sms-bb-no-phone';
  const token = captureToken('send-validation');
  await request(`${BASE_URL}/api/send-sms`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-Capture-Token': token },
    body: JSON.stringify({ message: marker }),
  });
  const calls = await readCapturesForToken(token);
  const surgeCalls = filterSurgeCalls(calls, marker);
  assert(
    surgeCalls.length === 0,
    `Expected 0 Surge calls for validation failure, got ` + `${surgeCalls.length}`
  );
}

/** POST /api/send-sms/direct missing fields -> 0 outbound calls. */
export async function testBoundary_directValidationNoOutbound() {
  const token = captureToken('direct-validation');
  await request(`${BASE_URL}/api/send-sms/direct`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-Capture-Token': token },
    body: JSON.stringify({}),
  });
  const calls = await readCapturesForToken(token);
  // No message was sent, so no Surge call can contain our marker.
  // Filter to our test phone to exclude concurrent domains' calls.
  const surgeCalls = calls.filter(
    (c) => c.url.includes('surge.app') && c.requestBody?.includes(TEST_PHONE)
  );
  assert(
    surgeCalls.length === 0,
    `Expected 0 Surge calls for validation failure, got ` + `${surgeCalls.length}`
  );
}

/** POST /api/send-sms/notify invalid event -> 0 outbound calls. */
export async function testBoundary_notifyValidationNoOutbound() {
  const token = captureToken('notify-validation');
  await request(`${BASE_URL}/api/send-sms/notify`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-Capture-Token': token },
    body: JSON.stringify({
      user_id: 'x',
      event_type: 'bad_type',
      agent_id: 'x',
    }),
  });
  const calls = await readCapturesForToken(token);
  // Invalid event type is rejected before any SMS send. Filter to our
  // test phone to exclude concurrent domains' Surge calls.
  const surgeCalls = calls.filter(
    (c) => c.url.includes('surge.app') && c.requestBody?.includes(TEST_PHONE)
  );
  assert(
    surgeCalls.length === 0,
    `Expected 0 Surge calls for validation failure, got ` + `${surgeCalls.length}`
  );
}

/** POST /api/send-sms/direct unknown user (no phone) -> 0 calls. */
export async function testBoundary_directUnknownUserNoOutbound() {
  const marker = 'send-sms-bb-unknown-user';
  const token = captureToken('direct-unknown-user');
  await request(`${BASE_URL}/api/send-sms/direct`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-Capture-Token': token },
    body: JSON.stringify({
      user_id: '00000000-0000-0000-0000-000000000000',
      message: marker,
    }),
  });
  const calls = await readCapturesForToken(token);
  const surgeCalls = filterSurgeCalls(calls, marker);
  assert(
    surgeCalls.length === 0,
    `Expected 0 Surge calls for unknown user, got ` + `${surgeCalls.length}`
  );
}
