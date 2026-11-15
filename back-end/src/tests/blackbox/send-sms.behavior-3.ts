import {
  captureToken,
  assert,
  createNotifyAgent,
  setNotificationFixture,
  request,
  BASE_URL,
  apiKeyHeaders,
  TEST_USER_ID,
  assertStatus,
  filterSurgeCalls,
  readCapturesForToken,
  assertAgentLinkPresent,
  assertLinkShorteningDisabled,
  prisma,
  clearNotificationFixture,
  TEST_PHONE,
  assertNoRoutingLeaks,
} from './send-sms.support';

export async function testBoundary_notifyAgentStartedKeepsLongGoalInsideAgent() {
  const token = captureToken('notify-started-long-goal');
  // Match the captured incident's 1670-character internal task without real credentials.
  const privateInstruction = 'INTERNAL_TASK_CREDENTIAL_SENTINEL';
  const goal = `${privateInstruction}\n${'Account setup instructions. '.repeat(70)}`.slice(0, 1670);
  assert(goal.length === 1670, 'Expected the captured incident goal length');
  const agent = await createNotifyAgent(goal);
  const agentLink = `https://roselabs.ai/a/${agent.id}`;
  const corrected = `I'm on it: Set up the requested accounts.\nFollow along: ${agentLink}`;
  try {
    await setNotificationFixture(agent.id, [
      {
        expected_tool_result_substrings: ['1754', 'should be at most 1600 character(s)'],
        message: 'x'.repeat(1601),
      },
      {
        expected_tool_result_substrings: ['1601', 'should be at most 1600 character(s)'],
        message: corrected,
      },
    ]);
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
    const calls = filterSurgeCalls(await readCapturesForToken(token));
    assert(calls.length === 1, `Expected one kickoff SMS, got ${calls.length}`);
    const body = JSON.parse(calls[0].requestBody!);
    assert(
      body.body.length <= 1600,
      `Kickoff SMS exceeds captured Surge limit: ${body.body.length} > 1600`
    );
    assert(
      !body.body.includes(privateInstruction),
      'Kickoff SMS leaked internal task instructions'
    );
    assertAgentLinkPresent(body.body, agent.id);
    assertLinkShorteningDisabled(body);
    assert(body.body === corrected, 'Expected the corrected model notification');
    const persisted = await prisma.agent.findUnique({ where: { id: agent.id } });
    assert(persisted?.goal === goal, 'Notification formatting changed the full agent goal');
  } finally {
    await clearNotificationFixture(agent.id);
    await prisma.agent.deleteMany({ where: { id: agent.id } });
  }
}

export async function testBoundary_notificationSummarizesInternalGoalLinks(): Promise<void> {
  const token = captureToken('notify-internal-goal-links');
  const internalLinks = Array.from(
    { length: 4 },
    (_, index) => `https://example.test/internal-source-${index}?context=${'q'.repeat(450)}`
  );
  const goal = `Review the full task using these internal sources:\n${internalLinks.map((link) => `(${link})`).join('\n')}`;
  assert(goal.length > 1600, 'Expected internal source links to exceed the SMS body limit');
  const agent = await createNotifyAgent(goal);
  const corrected = `I'm on it: Review the requested task.\nFollow along: https://roselabs.ai/a/${agent.id}`;
  try {
    await setNotificationFixture(agent.id, {
      expected_tool_result_substrings: ['should be at most 1600 character(s)'],
      message: corrected,
    });
    const response = await request(`${BASE_URL}/api/send-sms/notify`, {
      method: 'POST',
      headers: { ...apiKeyHeaders(), 'X-Capture-Token': token },
      body: JSON.stringify({
        user_id: TEST_USER_ID,
        agent_id: agent.id,
        event_type: 'agent_started',
        payload: { goal },
      }),
    });
    assertStatus(response.status, 200, response.data);
    const calls = filterSurgeCalls(await readCapturesForToken(token));
    assert(calls.length === 1, `Expected one accepted kickoff summary, got ${calls.length}`);
    assert(calls[0].responseStatus === 200, 'Expected summary accepted');
    const body = JSON.parse(calls[0].requestBody!).body as string;
    assert(body === corrected && body.length <= 1600, 'Expected the complete bounded summary');
    assertAgentLinkPresent(body, agent.id);
    assert(
      internalLinks.every((link) => !body.includes(link)),
      'Internal task links leaked'
    );
    const persisted = await prisma.agent.findUnique({ where: { id: agent.id } });
    assert(persisted?.goal === goal, 'Notification changed the full underlying task');
  } finally {
    await clearNotificationFixture(agent.id);
    await prisma.agent.deleteMany({ where: { id: agent.id } });
  }
}

export async function testBoundary_notificationRequiresCanonicalActionLink(): Promise<void> {
  const token = captureToken('notify-missing-action-link');
  const goal = 'Internal planning details. '.repeat(80);
  const agent = await createNotifyAgent(goal);
  const corrected = `I'm on it: Review the requested task.\nFollow along: https://roselabs.ai/a/${agent.id}`;
  try {
    await setNotificationFixture(agent.id, [
      { message: "I'm on it: Review the requested task." },
      {
        expected_tool_result_substrings: ['omitted a required link'],
        message: corrected,
      },
    ]);
    const response = await request(`${BASE_URL}/api/send-sms/notify`, {
      method: 'POST',
      headers: { ...apiKeyHeaders(), 'X-Capture-Token': token },
      body: JSON.stringify({
        user_id: TEST_USER_ID,
        agent_id: agent.id,
        event_type: 'agent_started',
        payload: { goal },
      }),
    });
    assertStatus(response.status, 200, response.data);
    const calls = filterSurgeCalls(await readCapturesForToken(token));
    assert(calls.length === 1, `Missing action link reached transport; got ${calls.length} calls`);
    assert(
      JSON.parse(calls[0].requestBody!).body === corrected,
      'Expected restored exact action link'
    );
  } finally {
    await clearNotificationFixture(agent.id);
    await prisma.agent.deleteMany({ where: { id: agent.id } });
  }
}

/** Isolate SMS rejection controls from shared-user WhatsApp reachability. */
async function createSmsOnlyNotifyFixture(goal: string) {
  const userId = crypto.randomUUID();
  const phone = `+1555${String(parseInt(userId.replaceAll('-', '').slice(0, 8), 16) % 10_000_000).padStart(7, '0')}`;
  await prisma.user.create({
    data: { userId, phone, isAnonymous: true, whatsappReachable: false },
  });
  try {
    const agent = await prisma.agent.create({
      data: { userId, goal, status: 'ACTIVE', source: 'SMS', progress: 0.25 },
    });
    return { userId, agent };
  } catch (error) {
    await prisma.user.deleteMany({ where: { userId } });
    throw error;
  }
}

export async function testBoundary_notificationDoesNotRewriteNonContentRejections(): Promise<void> {
  for (const status of [401, 403, 404, 429]) {
    const token = captureToken(`notify-noncontent-${status}`);
    const goal = `Set up the requested account. __BLACKBOX_SURGE_${status}__`;
    const { agent, userId } = await createSmsOnlyNotifyFixture(goal);
    try {
      await setNotificationFixture(agent.id, {
        message: `I'm on it: Set up the requested account.\nFollow along: https://roselabs.ai/a/${agent.id}`,
      });
      const response = await request(`${BASE_URL}/api/send-sms/notify`, {
        method: 'POST',
        headers: { ...apiKeyHeaders(), 'X-Capture-Token': token },
        body: JSON.stringify({
          user_id: userId,
          agent_id: agent.id,
          event_type: 'agent_started',
          payload: { goal },
        }),
      });
      assertStatus(response.status, 500, response.data);
      const calls = filterSurgeCalls(await readCapturesForToken(token));
      assert(
        calls.length === 1,
        `HTTP ${status} caused a model rewrite/resend: ${calls.length} calls`
      );
      assert(calls[0].responseStatus === status, `Expected HTTP ${status} replay`);
    } finally {
      try {
        await clearNotificationFixture(agent.id);
      } finally {
        try {
          await prisma.agent.deleteMany({ where: { id: agent.id } });
        } finally {
          await prisma.user.deleteMany({ where: { userId } });
        }
      }
    }
  }
}

export async function testBoundary_notificationRepairsHttp400BodyRejection(): Promise<void> {
  const token = captureToken('notify-content-400');
  const goal = 'Set up the requested account. __BLACKBOX_SURGE_400__';
  const agent = await createNotifyAgent(goal);
  const corrected = `I'm on it: Set up the requested account.\nFollow along: https://roselabs.ai/a/${agent.id}`;
  try {
    await setNotificationFixture(agent.id, {
      expected_tool_result_substrings: ['Surge API error: 400', 'body rejected by provider'],
      message: corrected,
    });
    const response = await request(`${BASE_URL}/api/send-sms/notify`, {
      method: 'POST',
      headers: { ...apiKeyHeaders(), 'X-Capture-Token': token },
      body: JSON.stringify({
        user_id: TEST_USER_ID,
        agent_id: agent.id,
        event_type: 'agent_started',
        payload: { goal },
      }),
    });
    assertStatus(response.status, 200, response.data);
    const calls = filterSurgeCalls(await readCapturesForToken(token));
    assert(
      calls.length === 2,
      `Expected one HTTP 400 rejection then correction, got ${calls.length}`
    );
    assert(
      calls[0].responseStatus === 400 && calls[1].responseStatus === 200,
      'Expected rejected then accepted'
    );
    assert(JSON.parse(calls[1].requestBody!).body === corrected, 'Expected exact model correction');
  } finally {
    await clearNotificationFixture(agent.id);
    await prisma.agent.deleteMany({ where: { id: agent.id } });
  }
}

export async function testBoundary_notificationRepairsProviderRejection(): Promise<void> {
  const token = captureToken('notify-provider-rejection');
  const goal = 'Set up the requested account. __BLACKBOX_SURGE_422__';
  const agent = await createNotifyAgent(goal);
  const corrected = `I'm on it: Set up the requested account.\nFollow along: https://roselabs.ai/a/${agent.id}`;
  try {
    await setNotificationFixture(agent.id, {
      expected_tool_result_substrings: ['Surge API error: 422', 'body rejected by provider'],
      message: corrected,
    });
    const response = await request(`${BASE_URL}/api/send-sms/notify`, {
      method: 'POST',
      headers: { ...apiKeyHeaders(), 'X-Capture-Token': token },
      body: JSON.stringify({
        user_id: TEST_USER_ID,
        agent_id: agent.id,
        event_type: 'agent_started',
        payload: { goal },
      }),
    });
    assertStatus(response.status, 200, response.data);
    const calls = filterSurgeCalls(await readCapturesForToken(token));
    assert(calls.length === 2, `Expected rejected then corrected send, got ${calls.length}`);
    assert(calls[0].responseStatus === 422, 'Expected explicit provider rejection');
    assert(calls[1].responseStatus === 200, 'Expected corrected send accepted');
    assert(JSON.parse(calls[1].requestBody!).body === corrected, 'Expected model correction sent');
    const session = await prisma.smsSession.findUnique({ where: { userId: TEST_USER_ID } });
    const stored = JSON.parse(session!.messages) as Array<{
      content: string;
      providerMessageId?: string;
    }>;
    assert(
      stored.some((entry) => entry.content === corrected),
      'Corrected receipt missing from transcript'
    );
    assert(
      !stored.some((entry) => entry.content.includes('__BLACKBOX_SURGE_422__')),
      'Rejected receipt entered transcript'
    );
  } finally {
    await clearNotificationFixture(agent.id);
    await prisma.agent.deleteMany({ where: { id: agent.id } });
  }
}

export async function testBoundary_notificationDoesNotRetryAmbiguousFailure(): Promise<void> {
  const token = captureToken('notify-ambiguous-failure');
  const goal = 'Set up the requested account. __BLACKBOX_SURGE_502__';
  const { agent, userId } = await createSmsOnlyNotifyFixture(goal);
  try {
    await setNotificationFixture(agent.id, {
      message: 'This must not be sent after a gateway failure.',
    });
    const response = await request(`${BASE_URL}/api/send-sms/notify`, {
      method: 'POST',
      headers: { ...apiKeyHeaders(), 'X-Capture-Token': token },
      body: JSON.stringify({
        user_id: userId,
        agent_id: agent.id,
        event_type: 'agent_started',
        payload: { goal },
      }),
    });
    assertStatus(response.status, 500, response.data);
    const calls = filterSurgeCalls(await readCapturesForToken(token));
    assert(calls.length === 1, `Ambiguous failure must not trigger a resend; got ${calls.length}`);
    assert(calls[0].responseStatus === 502, 'Expected gateway failure fixture');
  } finally {
    try {
      await clearNotificationFixture(agent.id);
    } finally {
      try {
        await prisma.agent.deleteMany({ where: { id: agent.id } });
      } finally {
        await prisma.user.deleteMany({ where: { userId } });
      }
    }
  }
}

export async function testRealLlm_notificationKeepsDeliveryContract(): Promise<void> {
  if (process.env.BLACKBOX_SMS_NOTIFICATION_REAL_LLM !== '1') return;
  const token = captureToken('notify-real-llm');
  const goal = `Prepare the quarterly marketing report and email the recommendations after completion.\n${'Internal planning: collect metrics, compare campaigns, and check the conclusions.\n'.repeat(35)}`;
  const agent = await createNotifyAgent(goal);
  try {
    const response = await request(`${BASE_URL}/api/send-sms/notify`, {
      method: 'POST',
      headers: { ...apiKeyHeaders(), 'X-Capture-Token': token },
      body: JSON.stringify({
        user_id: TEST_USER_ID,
        agent_id: agent.id,
        event_type: 'agent_started',
        payload: { goal },
      }),
    });
    assertStatus(response.status, 200, response.data);
    const calls = filterSurgeCalls(await readCapturesForToken(token));
    assert(
      calls.length === 1,
      `Expected one accepted model-written notification, got ${calls.length}`
    );
    const body = JSON.parse(calls[0].requestBody!);
    assert(body.body.length <= 1600, `Real model violated SMS length limit: ${body.body.length}`);
    assertAgentLinkPresent(body.body, agent.id);
    console.log(`    Live notification model accepted: ${body.body.length} characters`);
  } finally {
    await prisma.agent.deleteMany({ where: { id: agent.id } });
  }
}

export async function testBoundary_notifyCostLimitIncludesTaskGoal() {
  const token = captureToken('notify-cost-limit');
  const goal = 'boundary cost limit dinner booking task';
  const agent = await createNotifyAgent(goal);
  try {
    const res = await request(`${BASE_URL}/api/send-sms/notify`, {
      method: 'POST',
      headers: { ...apiKeyHeaders(), 'X-Capture-Token': token },
      body: JSON.stringify({
        user_id: TEST_USER_ID,
        event_type: 'cost_limit',
        agent_id: agent.id,
        payload: { tree_cost_cents: 150, price_limit_cents: 150 },
      }),
    });
    assertStatus(res.status, 200, res.data);
    const calls = await readCapturesForToken(token);
    const surgeCalls = filterSurgeCalls(calls, goal);
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
      body.body.includes(`"${goal}" at the $1.50 budget limit`),
      `Expected cost-limit message to include task goal, got: ${body.body.substring(0, 160)}`
    );
    assert(
      !body.body.includes('after spending'),
      `Expected cost-limit spend details, got: ${body.body.substring(0, 160)}`
    );
    assertNoRoutingLeaks(body.body, agent.id);
  } finally {
    await prisma.agent.deleteMany({ where: { id: agent.id } });
  }
}
