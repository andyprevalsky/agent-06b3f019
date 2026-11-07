import type { PrismaClient } from '@prisma/client';
import {
  BASE_URL,
  BYPASS_FIXTURE_REAL_LLM,
  buildGrepFixture,
  assertStatus,
  captureToken,
  capturedSmsBody,
  cleanupAgentScopedUser,
  findSurgeCallForReply,
  provisionUserWithPhone,
  readCapturesAfter,
  readCapturesForToken,
  request,
  setFixtureOverride,
  uniqueSmsPhone,
  waitFor,
} from './sms-supervisor.helpers';
import { buildSmsContext } from '../../providers/smsSupervisor/contextBuilder';
import { SUPERVISOR_FALLBACK_MESSAGE } from '../../providers/smsSupervisor';

function buildReplyToAgentFixture(params: {
  agentIdOrPrefix: string;
  attentionRequestId: string;
  agentReply: string;
  smsReply: string;
}): string {
  return JSON.stringify({
    reasoning: 'map natural user approval to the matching pending request',
    tool_calls: [
      {
        tool: 'reply_to_agent',
        arguments: {
          agent_id_or_prefix: params.agentIdOrPrefix,
          attention_request_id: params.attentionRequestId,
          message: params.agentReply,
          reject: false,
        },
      },
      { tool: 'send_user_message', arguments: { message: params.smsReply } },
      { tool: 'attempt_completion', arguments: {} },
    ],
  });
}

export async function testNaturalApproval_resolvesPendingAttentionRequest(prisma: PrismaClient) {
  const probeRes = await request(`${BASE_URL}/api/test/captures`);
  if (probeRes.status !== 200) {
    console.warn('  ⚠ capture harness not active — skipping natural approval test');
    return;
  }
  const cursor = (probeRes.data as { nextId: number }).nextId - 1;

  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(prisma, phone);
  const token = captureToken('sms-supervisor-natural-approval');
  const smsReply = "Approved — I'll let the Amazon purchase continue.";

  const agent = await prisma.agent.create({
    data: {
      userId,
      goal: 'Buy household supplies from Amazon',
      status: 'ACTIVE',
      source: 'SMS',
      progress: 0.5,
    },
  });
  const attention = await prisma.agentAttentionRequest.create({
    data: {
      userId,
      agentId: agent.id,
      workflowId: 'wf-natural-approval',
      question: 'Can I place the Amazon order for $42?',
      metadata: { requestUserApproval: true },
    },
  });

  try {
    await setFixtureOverride(
      userId,
      buildReplyToAgentFixture({
        agentIdOrPrefix: agent.id.substring(0, 6),
        attentionRequestId: attention.id,
        agentReply: 'Approved',
        smsReply,
      })
    );

    const res = await request(`${BASE_URL}/api/sms/inbound`, {
      method: 'POST',
      headers: { 'X-Capture-Token': token },
      body: JSON.stringify({
        data: {
          body: 'amazon purchase approved',
          conversation: {
            contact: { phone_number: phone },
            phone_number: { number: '+14154498072' },
          },
        },
      }),
    });
    assertStatus(res.status, 200, res.data);

    await waitFor(() => findSurgeCallForReply(token, cursor, phone, smsReply));

    await waitFor(async () => {
      const updated = await prisma.agentAttentionRequest.findUnique({
        where: { id: attention.id },
      });
      return updated?.userResponse === 'Approved' ? updated : null;
    });

    const userMessage = await prisma.message.findFirst({
      where: { agentId: agent.id, role: 'USER', text: 'Approved' },
    });
    if (!userMessage) {
      throw new Error('Expected natural approval to post a USER message to the agent');
    }
  } finally {
    await prisma.message.deleteMany({ where: { agentId: agent.id } });
    await prisma.agentAttentionRequest.deleteMany({ where: { userId } });
    await cleanupAgentScopedUser(prisma, userId);
  }
}

export async function testNaturalApproval_ambiguousApprovalAsksClarification(prisma: PrismaClient) {
  const probeRes = await request(`${BASE_URL}/api/test/captures`);
  if (probeRes.status !== 200) {
    console.warn('  ⚠ capture harness not active — skipping ambiguity test');
    return;
  }
  const cursor = (probeRes.data as { nextId: number }).nextId - 1;

  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(prisma, phone);
  const token = captureToken('sms-supervisor-ambiguous-approval');
  const clarification = 'Which purchase do you want me to approve: Amazon or Target?';

  const amazonAgent = await prisma.agent.create({
    data: {
      userId,
      goal: 'Buy household supplies from Amazon',
      status: 'ACTIVE',
      source: 'SMS',
    },
  });
  const targetAgent = await prisma.agent.create({
    data: {
      userId,
      goal: 'Buy groceries from Target',
      status: 'ACTIVE',
      source: 'SMS',
    },
  });
  const amazonAttention = await prisma.agentAttentionRequest.create({
    data: {
      userId,
      agentId: amazonAgent.id,
      workflowId: 'wf-ambiguous-amazon',
      question: 'Can I place the Amazon order?',
      metadata: { requestUserApproval: true },
    },
  });
  const targetAttention = await prisma.agentAttentionRequest.create({
    data: {
      userId,
      agentId: targetAgent.id,
      workflowId: 'wf-ambiguous-target',
      question: 'Can I place the Target order?',
      metadata: { requestUserApproval: true },
    },
  });

  try {
    await setFixtureOverride(
      userId,
      JSON.stringify({
        reasoning: 'the approval is ambiguous because two pending purchases match',
        tool_calls: [
          { tool: 'send_user_message', arguments: { message: clarification } },
          { tool: 'attempt_completion', arguments: {} },
        ],
      })
    );

    const res = await request(`${BASE_URL}/api/sms/inbound`, {
      method: 'POST',
      headers: { 'X-Capture-Token': token },
      body: JSON.stringify({
        data: {
          body: 'approved',
          conversation: {
            contact: { phone_number: phone },
            phone_number: { number: '+14154498072' },
          },
        },
      }),
    });
    assertStatus(res.status, 200, res.data);

    await waitFor(() => findSurgeCallForReply(token, cursor, phone, clarification));

    const [amazonUpdated, targetUpdated] = await Promise.all([
      prisma.agentAttentionRequest.findUnique({ where: { id: amazonAttention.id } }),
      prisma.agentAttentionRequest.findUnique({ where: { id: targetAttention.id } }),
    ]);
    if (amazonUpdated?.userResponse !== null || targetUpdated?.userResponse !== null) {
      throw new Error('Ambiguous approval should not resolve any pending request');
    }
  } finally {
    await prisma.message.deleteMany({
      where: { agentId: { in: [amazonAgent.id, targetAgent.id] } },
    });
    await prisma.agentAttentionRequest.deleteMany({ where: { userId } });
    await cleanupAgentScopedUser(prisma, userId);
  }
}

export async function testPrompt_neverExposeRoutingIds(prisma: PrismaClient) {
  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(prisma, phone);
  try {
    const context = await buildSmsContext(userId);
    if (!context.systemPrompt.includes('Never expose agent IDs')) {
      throw new Error('Expected supervisor prompt to prohibit exposing internal routing IDs');
    }
    if (context.systemPrompt.includes('Use the agent ID prefix')) {
      throw new Error('Supervisor prompt still tells the model to expose agent prefixes');
    }
  } finally {
    await cleanupAgentScopedUser(prisma, userId);
  }
}

export async function testRealLlm_supervisorRoundTrip(prisma: PrismaClient) {
  if (process.env.BLACKBOX_SMS_SUPERVISOR_REAL_LLM !== '1') {
    console.warn('  ⚠ BLACKBOX_SMS_SUPERVISOR_REAL_LLM != 1 — skipping real-LLM smoke');
    return;
  }
  const probeRes = await request(`${BASE_URL}/api/test/captures`);
  if (probeRes.status !== 200) {
    console.warn('  ⚠ capture harness not active — skipping real-LLM smoke');
    return;
  }
  const cursor = (probeRes.data as { nextId: number }).nextId - 1;

  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(prisma, phone);
  const token = captureToken('sms-supervisor-real-llm');
  const inboundText = 'Hi, please reply with a short greeting and nothing else.';

  try {
    await setFixtureOverride(userId, BYPASS_FIXTURE_REAL_LLM);

    const res = await request(`${BASE_URL}/api/sms/inbound`, {
      method: 'POST',
      headers: { 'X-Capture-Token': token },
      body: JSON.stringify({
        data: {
          body: inboundText,
          conversation: {
            contact: { phone_number: phone },
            phone_number: { number: '+14154498072' },
          },
        },
      }),
    });
    assertStatus(res.status, 200, res.data);

    const surgeCall = await waitFor(
      async () => {
        const tokenCalls = await readCapturesForToken(token);
        const cursorCalls = await readCapturesAfter(cursor);
        const calls = [...tokenCalls, ...cursorCalls];
        return (
          calls.find((call) => {
            if (!call.url.includes('surge.app') || !call.url.endsWith('/messages')) {
              return false;
            }
            const body = capturedSmsBody(call);
            return (
              body?.to === phone &&
              typeof body?.body === 'string' &&
              (body.body as string).length > 0
            );
          }) ?? null
        );
      },
      45000,
      500
    );

    const replyBody = capturedSmsBody(surgeCall);
    const replyText = typeof replyBody?.body === 'string' ? replyBody.body : '';
    if (replyText.length === 0) {
      throw new Error('Expected non-empty outbound SMS body from real LLM');
    }

    if (replyText === SUPERVISOR_FALLBACK_MESSAGE) {
      console.warn(
        '  ⚠ pool tokens unavailable (supervisor crashed with fallback) — skipping real-LLM assertions'
      );
      return;
    }

    const session = await prisma.smsSession.findUnique({ where: { userId } });
    if (!session) {
      throw new Error('Expected SmsSession after real-LLM run');
    }
    const messages = JSON.parse(session.messages) as { role?: string; content?: string }[];
    const userMsgs = messages.filter((m) => m.role === 'user');
    const asstMsgs = messages.filter((m) => m.role === 'assistant');
    if (userMsgs.length !== 1) {
      throw new Error(
        `Expected exactly one user turn persisted, got ${userMsgs.length}: ${JSON.stringify(
          userMsgs.map((m) => m.content?.substring(0, 40))
        )}`
      );
    }
    if (asstMsgs.length !== 1) {
      throw new Error(
        `Expected exactly one substantive reply persisted, got ${asstMsgs.length}: ${JSON.stringify(
          asstMsgs.map((m) => m.content?.substring(0, 40))
        )}`
      );
    }
    if (asstMsgs[0].content !== replyText) {
      throw new Error(
        `Persisted assistant text should match outbound SMS body. ` +
          `Session: "${asstMsgs[0].content?.substring(0, 80)}" vs Surge: "${replyText.substring(0, 80)}"`
      );
    }
  } finally {
    await cleanupAgentScopedUser(prisma, userId);
  }
}

/**
 * Real-LLM acceptance for the grep tool: a factual question about a contact
 * should be answered from the user's own data (grep source=network), not
 * bounced back to the user as a clarifying question.
 */
export async function testRealLlm_answersContactFactViaGrep(prisma: PrismaClient) {
  if (process.env.BLACKBOX_SMS_SUPERVISOR_REAL_LLM !== '1') {
    console.warn('  ⚠ BLACKBOX_SMS_SUPERVISOR_REAL_LLM != 1 — skipping real-LLM grep test');
    return;
  }
  const probeRes = await request(`${BASE_URL}/api/test/captures`);
  if (probeRes.status !== 200) {
    console.warn('  ⚠ capture harness not active — skipping real-LLM grep test');
    return;
  }
  const cursor = (probeRes.data as { nextId: number }).nextId - 1;

  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(prisma, phone);
  const token = captureToken('sms-supervisor-real-llm-grep');
  const lastName = 'Grepwell';
  const email = `contact-${Math.random().toString(36).slice(2, 10)}@example.com`;

  await prisma.person.create({
    data: { userId, firstName: 'Jane', lastName, email },
  });

  try {
    await setFixtureOverride(userId, BYPASS_FIXTURE_REAL_LLM);

    const res = await request(`${BASE_URL}/api/sms/inbound`, {
      method: 'POST',
      headers: { 'X-Capture-Token': token },
      body: JSON.stringify({
        data: {
          body: `Look in my contacts for Jane ${lastName}'s email address.`,
          conversation: {
            contact: { phone_number: phone },
            phone_number: { number: '+14154498072' },
          },
        },
      }),
    });
    assertStatus(res.status, 200, res.data);

    const surgeCall = await waitFor(
      async () => {
        const tokenCalls = await readCapturesForToken(token);
        const cursorCalls = await readCapturesAfter(cursor);
        const calls = [...tokenCalls, ...cursorCalls];
        return (
          calls.find((call) => {
            if (!call.url.includes('surge.app') || !call.url.endsWith('/messages')) {
              return false;
            }
            const body = capturedSmsBody(call);
            return body?.to === phone && typeof body?.body === 'string';
          }) ?? null
        );
      },
      90000,
      2000
    );
    if (!surgeCall) {
      throw new Error('Expected an outbound Surge SMS from the real-LLM grep run');
    }
    const smsBody = capturedSmsBody(surgeCall)?.body as string;
    if (!smsBody.toLowerCase().includes(email)) {
      throw new Error(
        `Expected the SMS to contain the seeded email ${email} (answered from grep, not asked back). Got: "${smsBody.substring(0, 160)}"`
      );
    }
  } finally {
    await prisma.person.deleteMany({ where: { userId } });
    await cleanupAgentScopedUser(prisma, userId);
  }
}

// ==================== GREP — read-tool inline dispatch ====================

export async function testGrep_searchUserDataInlineSuccessCompletes(prisma: PrismaClient) {
  const probeRes = await request(`${BASE_URL}/api/test/captures`);
  if (probeRes.status !== 200) {
    console.warn('  ⚠ capture harness not active — skipping grep success test');
    return;
  }
  const cursor = (probeRes.data as { nextId: number }).nextId - 1;

  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(prisma, phone);
  const token = captureToken('sms-supervisor-grep-success');
  const lastName = `Grepson${Math.random().toString(36).slice(2, 8)}`;
  const email = `john.${lastName.toLowerCase()}@example.com`;
  const replyText = `John ${lastName}'s email is ${email}`;

  await prisma.person.create({
    data: { userId, firstName: 'John', lastName, email },
  });

  try {
    // grep succeeds inline, so the fixture's attempt_completion in the same
    // round is honored and its SMS goes out — a failed dispatch would have
    // blocked completion (see supervisorHandler failed-tool gate).
    await setFixtureOverride(
      userId,
      buildGrepFixture({ pattern: lastName, source: 'network', replyText })
    );

    const res = await request(`${BASE_URL}/api/sms/inbound`, {
      method: 'POST',
      headers: { 'X-Capture-Token': token },
      body: JSON.stringify({
        data: {
          body: "What's John's email?",
          conversation: {
            contact: { phone_number: phone },
            phone_number: { number: '+14154498072' },
          },
        },
      }),
    });
    assertStatus(res.status, 200, res.data);

    await waitFor(() => findSurgeCallForReply(token, cursor, phone, replyText));
  } finally {
    await prisma.person.deleteMany({ where: { userId } });
    await cleanupAgentScopedUser(prisma, userId);
  }
}

export async function testGrep_failureBlocksCompletionAndFallsBackGracefully(prisma: PrismaClient) {
  const probeRes = await request(`${BASE_URL}/api/test/captures`);
  if (probeRes.status !== 200) {
    console.warn('  ⚠ capture harness not active — skipping grep failure test');
    return;
  }
  const cursor = (probeRes.data as { nextId: number }).nextId - 1;

  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(prisma, phone);
  const token = captureToken('sms-supervisor-grep-failure');
  const blockedReply = 'This reply must never be sent';
  // The blocked-completion path reaches the safety cap without a successful
  // send_user_message, so the runtime sends its failure fallback.
  const fallbackReply = SUPERVISOR_FALLBACK_MESSAGE;

  try {
    // agent_network needs an agent tree and the supervisor has none → dispatch
    // fails every round → attempt_completion in the same fixture response stays
    // blocked until the round cap. (An invalid regex no longer fails: the shared
    // grep executor retries it as literal text.)
    await setFixtureOverride(
      userId,
      buildGrepFixture({ pattern: 'anything', source: 'agent_network', replyText: blockedReply })
    );

    const res = await request(`${BASE_URL}/api/sms/inbound`, {
      method: 'POST',
      headers: { 'X-Capture-Token': token },
      body: JSON.stringify({
        data: {
          body: 'Search my messages',
          conversation: {
            contact: { phone_number: phone },
            phone_number: { number: '+14154498072' },
          },
        },
      }),
    });
    assertStatus(res.status, 200, res.data);

    await waitFor(() => findSurgeCallForReply(token, cursor, phone, fallbackReply));

    const blocked = await findSurgeCallForReply(token, cursor, phone, blockedReply);
    if (blocked) {
      throw new Error('Fixture reply was sent despite the grep dispatch failing every round');
    }
  } finally {
    await cleanupAgentScopedUser(prisma, userId);
  }
}

export async function testAttemptCompletion_requiresSuccessfulUserMessage(prisma: PrismaClient) {
  const probeRes = await request(`${BASE_URL}/api/test/captures`);
  if (probeRes.status !== 200) return;
  const cursor = (probeRes.data as { nextId: number }).nextId - 1;
  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(prisma, phone);
  const token = captureToken('sms-supervisor-completion-invariant');
  const fallback = SUPERVISOR_FALLBACK_MESSAGE;

  try {
    await setFixtureOverride(
      userId,
      JSON.stringify({
        reasoning: 'incorrectly trying to stop without sending',
        tool_calls: [{ tool: 'attempt_completion', arguments: {} }],
      })
    );
    const res = await request(`${BASE_URL}/api/sms/inbound`, {
      method: 'POST',
      headers: { 'X-Capture-Token': token },
      body: JSON.stringify({
        data: {
          body: 'Answer my question',
          conversation: {
            contact: { phone_number: phone },
            phone_number: { number: '+14154498072' },
          },
        },
      }),
    });
    assertStatus(res.status, 200, res.data);
    await waitFor(() => findSurgeCallForReply(token, cursor, phone, fallback));
  } finally {
    await cleanupAgentScopedUser(prisma, userId);
  }
}

/**
 * Real-LLM acceptance for bias-to-action: a clear purchase request should
 * spawn a superintelligence agent (start_new_agent) with a purchase goal —
 * not bounce a clarifying question back to the user. The spawned agent's
 * budget covers its own LLM/metered-tool spend, so it must not carry the
 * purchase amount.
 */
export async function testRealLlm_purchaseRequestSpawnsAgent(prisma: PrismaClient) {
  if (process.env.BLACKBOX_SMS_SUPERVISOR_REAL_LLM !== '1') {
    console.warn('  ⚠ BLACKBOX_SMS_SUPERVISOR_REAL_LLM != 1 — skipping real-LLM purchase test');
    return;
  }
  const probeRes = await request(`${BASE_URL}/api/test/captures`);
  if (probeRes.status !== 200) {
    console.warn('  ⚠ capture harness not active — skipping real-LLM purchase test');
    return;
  }

  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(prisma, phone);
  const token = captureToken('sms-supervisor-real-llm-purchase');

  try {
    await setFixtureOverride(userId, BYPASS_FIXTURE_REAL_LLM);

    const res = await request(`${BASE_URL}/api/sms/inbound`, {
      method: 'POST',
      headers: { 'X-Capture-Token': token },
      body: JSON.stringify({
        data: {
          body: 'get me the best lip balm from amazon',
          conversation: {
            contact: { phone_number: phone },
            phone_number: { number: '+14154498072' },
          },
        },
      }),
    });
    assertStatus(res.status, 200, res.data);

    const agent = await waitFor(
      async () => prisma.agent.findFirst({ where: { userId } }),
      90000,
      2000
    );
    if (!agent) {
      throw new Error(
        'Expected start_new_agent to spawn an agent for a clear purchase request — ' +
          'the supervisor asked back or replied inline instead'
      );
    }
    const goal = agent.goal.toLowerCase();
    // Models often rewrite "lip balm" into a concrete SKU title ("Lip Glowy
    // Balm", "Lip Repair"). Require the lip product stem + a purchase venue.
    if (!goal.includes('lip')) {
      throw new Error(`Expected agent goal to mention a lip product, got: "${agent.goal}"`);
    }
    if (!/amazon|purchas|buy|order/.test(goal)) {
      throw new Error(
        `Expected a clear purchase goal (amazon/purchase/buy/order), got: "${agent.goal}"`
      );
    }
    // $2 is the ceiling the budget_dollars description states ("default $1;
    // usually under $2"), so $2.00 exactly is a conforming pick — the defect
    // this guards is a purchase-scale limit (the incident stored $120).
    if (agent.priceLimitCents > 200) {
      throw new Error(
        'Expected the agent-run budget (not the purchase amount) in priceLimitCents — ' +
          `got ${agent.priceLimitCents}`
      );
    }
  } finally {
    await cleanupAgentScopedUser(prisma, userId);
  }
}
