/**
 * Black-box tests for the SMS supervisor's tool-loop + deferred-commit gate.
 *
 * Sibling to sms-webhook.blackbox.ts. The webhook file covers HTTP-shape
 * invariants and the smoke loop; this file covers supervisor-side semantics:
 *
 *   - smoke: inbound → loop → outbound Surge SMS (third-party captured, not mocked)
 *   - boundary: unknown phone + invalid payload contracts
 *   - WS-2 race: 2 inbounds → exactly one outbound SMS (deferred-commit gate)
 *   - write-commit: start_new_agent fires on attempt_completion
 *   - WS-2 discard: suppressed run's queued start_new_agent is discarded
 *
 * Usage:
 *   npx tsx src/tests/blackbox/sms-supervisor.blackbox.ts
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import {
  BASE_URL,
  assertStatus,
  assertRecentCompletedRootStaysInHierarchy,
  buildStartNewAgentFixture,
  captureToken,
  cleanupAgentScopedUser,
  cleanupSessionScopedUser,
  dedupedSurgeRepliesFor,
  findSurgeCallForReply,
  fixtureSmsReply,
  provisionUserWithPhone,
  readCapturesForToken,
  request,
  runTest,
  setFixtureOverride,
  uniqueSmsPhone,
  waitFor,
} from './sms-supervisor.helpers';
import {
  testAttemptCompletion_requiresSuccessfulUserMessage,
  testGrep_failureBlocksCompletionAndFallsBackGracefully,
  testGrep_searchUserDataInlineSuccessCompletes,
  testNaturalApproval_ambiguousApprovalAsksClarification,
  testNaturalApproval_resolvesPendingAttentionRequest,
  testPrompt_neverExposeRoutingIds,
  testRealLlm_answersContactFactViaGrep,
  testRealLlm_purchaseRequestSpawnsAgent,
  testRealLlm_supervisorRoundTrip,
} from './sms-supervisor.behavior';
import { smsDeliveryBehaviorCases } from './sms-supervisor.delivery.behavior';
import { smsBluebottleBehaviorCases } from './sms-supervisor.bluebottle.behavior';
import {
  testRealLlm_photoAttachmentRoundTrip,
  testRealLlm_voiceNoteRoundTrip,
  testRealLlm_blueRecolorSpawnsAgentWithAllFiveAttachments,
  testWriteCommit_startNewAgentForwardsInboundImageAttachments,
} from './sms-supervisor.media.behavior';
import { bareRejectionBlackboxCase } from './sms-supervisor.intent.behavior';
import { smsTimezoneBehaviorCases } from './sms-supervisor.timezone.behavior';
import { smsPausedReplyBehaviorCases } from './sms-supervisor.paused-reply.behavior';
import { smsStartPhaseBehaviorCases } from './sms-supervisor.start-phase.behavior';
import { smsQueuedAgentBehaviorCases } from './sms-supervisor.queued-agent.behavior';
import { smsPhoneAttentionBehaviorCases } from './sms-supervisor.phone-attention.behavior';
import { buildToolFailureMessage } from '../../providers/smsSupervisor/supervisorHandler';
import { commitPendingWrites, PendingOp } from '../../providers/smsSupervisor/supervisorTools';
const prisma = new PrismaClient();

// ==================== SMOKE — inbound → supervisor loop → outbound SMS ====================

async function testSmoke_knownPhoneSupervisorSendsSmsResponse() {
  const probeRes = await request(`${BASE_URL}/api/test/captures`);
  if (probeRes.status !== 200) {
    console.warn('  ⚠ capture harness not active — skipping SMS supervisor smoke');
    return;
  }

  const expectedReply = fixtureSmsReply();
  if (!expectedReply) {
    console.warn('  ⚠ SMS supervisor fixture not configured — skipping deterministic smoke');
    return;
  }
  const cursor = (probeRes.data as { nextId: number }).nextId - 1;

  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(prisma, phone);
  const token = captureToken('sms-supervisor-smoke');
  const inboundText = 'Please send the SMS smoke response';

  try {
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

    const surgeCall = await waitFor(() =>
      findSurgeCallForReply(token, cursor, phone, expectedReply)
    );

    if (surgeCall.method !== 'POST') {
      throw new Error(`Expected outbound SMS POST, got ${surgeCall.method}`);
    }

    await waitFor(async () => {
      const session = await prisma.smsSession.findUnique({ where: { userId } });
      if (!session) {
        return null;
      }
      const messages = JSON.parse(session.messages) as { role?: string; content?: string }[];
      const hasInbound = messages.some((m) => m.role === 'user' && m.content === inboundText);
      const hasReply = messages.some((m) => m.role === 'assistant' && m.content === expectedReply);
      return hasInbound && hasReply ? session : null;
    });
  } finally {
    await cleanupSessionScopedUser(prisma, userId);
  }
}

// ==================== BOUNDARY ====================

async function testBoundary_inboundCapturesSurgeCall() {
  const cursorRes = await request(`${BASE_URL}/api/test/captures`);
  if (cursorRes.status !== 200) {
    console.warn('  ⚠ capture harness not active — skipping');
    return;
  }
  const cursor = (cursorRes.data as { nextId: number }).nextId - 1;

  // A first-time phone is now silently provisioned + routed to the supervisor,
  // which itself POSTs to Surge (async). We still assert any captured Surge call
  // is a well-formed POST /messages, then clean up the provisioned user.
  const phone = '+10000000099';
  try {
    await request(`${BASE_URL}/api/sms/inbound`, {
      method: 'POST',
      body: JSON.stringify({
        data: {
          body: 'Boundary test message',
          conversation: {
            contact: { phone_number: phone },
            phone_number: { number: '+14154498072' },
          },
        },
      }),
    });

    const capturesRes = await request(`${BASE_URL}/api/test/captures?after=${cursor}`);
    assertStatus(capturesRes.status, 200, capturesRes.data);
    const body = capturesRes.data as {
      captures: { url: string; method: string; requestHeaders: Record<string, string> }[];
    };

    const surgeCalls = body.captures.filter((c) => c.url.includes('surge.app'));
    if (surgeCalls.length === 0) {
      // SURGE_API_KEY not configured, or the async supervisor hasn't emitted its
      // reply yet — no outbound call captured, acceptable.
      return;
    }

    const call = surgeCalls[0];
    if (call.method !== 'POST') {
      throw new Error(`Expected POST to Surge, got ${call.method}`);
    }
    if (!call.url.includes('/messages')) {
      throw new Error(`Expected /messages in URL, got ${call.url}`);
    }
    const headerKeys = Object.keys(call.requestHeaders).map((k) => k.toLowerCase());
    if (!headerKeys.includes('authorization')) {
      throw new Error('Expected Authorization header in Surge call');
    }
  } finally {
    const user = await prisma.user.findFirst({ where: { phone } });
    if (user) {
      // Abort the async supervisor, then delete the provisioned rows.
      await request(`${BASE_URL}/api/sms/inbound`, {
        method: 'POST',
        body: JSON.stringify({
          data: {
            body: '/clear',
            conversation: {
              contact: { phone_number: phone },
              phone_number: { number: '+14154498072' },
            },
          },
        }),
      });
      await new Promise((r) => setTimeout(r, 200));
      await prisma.smsSession.deleteMany({ where: { userId: user.userId } });
      await prisma.credit.deleteMany({ where: { userId: user.userId } });
      await prisma.user.deleteMany({ where: { userId: user.userId } });
    }
  }
}

async function testBoundary_invalidPayloadZeroCaptures() {
  const probeRes = await request(`${BASE_URL}/api/test/captures`);
  if (probeRes.status !== 200) {
    console.warn('  ⚠ capture harness not active — skipping');
    return;
  }
  const token = captureToken('sms-supervisor-invalid-payload');

  await request(`${BASE_URL}/api/sms/inbound`, {
    method: 'POST',
    headers: { 'X-Capture-Token': token },
    body: JSON.stringify({}),
  });

  const captures = await readCapturesForToken(token);
  if (captures.length > 0) {
    throw new Error(
      `Expected 0 captures on invalid payload, got ${captures.length}: ${JSON.stringify(captures.map((c) => c.url))}`
    );
  }
}

// ==================== WS-2: deferred-commit + lastInboundSeq gate ====================

async function testWs2_consecutiveInboundCommitsOnlyLatest() {
  const probeRes = await request(`${BASE_URL}/api/test/captures`);
  if (probeRes.status !== 200) {
    console.warn('  ⚠ capture harness not active — skipping WS-2 race test');
    return;
  }
  const expectedReply = fixtureSmsReply();
  if (!expectedReply) {
    console.warn('  ⚠ SMS supervisor fixture not configured — skipping WS-2 race test');
    return;
  }
  const cursor = (probeRes.data as { nextId: number }).nextId - 1;

  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(prisma, phone);
  const token = captureToken('sms-supervisor-ws2-race');
  const firstText = 'WS2 first inbound — should be suppressed';
  const secondText = 'WS2 second inbound — should commit';

  try {
    // Fire both inbounds nearly together; the webhook handler bumps
    // lastInboundSeq atomically per call so the supervisor for the first SMS
    // sees mySeq=N and the second sees mySeq=N+1.
    const [resA, resB] = await Promise.all([
      request(`${BASE_URL}/api/sms/inbound`, {
        method: 'POST',
        headers: { 'X-Capture-Token': token },
        body: JSON.stringify({
          data: {
            body: firstText,
            conversation: {
              contact: { phone_number: phone },
              phone_number: { number: '+14154498072' },
            },
          },
        }),
      }),
      // Small stagger so B's seq bump lands after A's bump but before A
      // reaches its commit gate. The blackbox fixture short-circuits the LLM
      // call, so A's loop runs in tens of ms — 25ms is enough to slot B in.
      new Promise((r) => setTimeout(r, 25)).then(() =>
        request(`${BASE_URL}/api/sms/inbound`, {
          method: 'POST',
          headers: { 'X-Capture-Token': token },
          body: JSON.stringify({
            data: {
              body: secondText,
              conversation: {
                contact: { phone_number: phone },
                phone_number: { number: '+14154498072' },
              },
            },
          }),
        })
      ),
    ]);
    assertStatus(resA.status, 200, resA.data);
    assertStatus(resB.status, 200, resB.data);

    await waitFor(() => findSurgeCallForReply(token, cursor, phone, expectedReply));

    // Give the suppressed run a chance to attempt its commit so a double-send
    // would be observable. The fixture short-circuits the LLM, so both runs
    // finish within a few hundred ms.
    await new Promise<void>((r) => setTimeout(r, 600));

    // Critical invariant: exactly ONE outbound SMS to this phone, not two.
    const dedupedReplies = await dedupedSurgeRepliesFor(token, cursor, phone, expectedReply);
    if (dedupedReplies.length !== 1) {
      throw new Error(
        `Expected exactly one outbound Surge SMS for ${phone}, got ${dedupedReplies.length}: ${dedupedReplies.join(' || ')}`
      );
    }

    // Sanity: the session captures the fixture reply (from the committing run)
    // and lastInboundSeq advanced past 1 (both inbounds counted).
    const session = await prisma.smsSession.findUnique({ where: { userId } });
    if (!session) {
      throw new Error('Expected SmsSession to exist after WS-2 race');
    }
    if (session.lastInboundSeq < 2) {
      throw new Error(
        `Expected lastInboundSeq >= 2 after two inbounds, got ${session.lastInboundSeq}`
      );
    }
    const messages = JSON.parse(session.messages) as { role?: string; content?: string }[];
    const persistedInbound = messages
      .filter((message) => message.role === 'user')
      .map((message) => message.content);
    if (
      !persistedInbound.includes(firstText) ||
      !persistedInbound.includes(secondText) ||
      persistedInbound.indexOf(firstText) > persistedInbound.indexOf(secondText)
    ) {
      throw new Error(
        `Expected both inbound SMS records in arrival order, got ${JSON.stringify(persistedInbound)}`
      );
    }
    const replied = messages.some((m) => m.role === 'assistant' && m.content === expectedReply);
    if (!replied) {
      throw new Error('Expected the fixture reply to be persisted by the committing run');
    }
  } finally {
    await cleanupSessionScopedUser(prisma, userId);
  }
}

// ==================== WRITE-TOOL COMMIT — start_new_agent applies before user send ====================

async function testWriteCommit_startNewAgentCommitsBeforeUserSend() {
  const probeRes = await request(`${BASE_URL}/api/test/captures`);
  if (probeRes.status !== 200) {
    console.warn('  ⚠ capture harness not active — skipping write-commit test');
    return;
  }
  const cursor = (probeRes.data as { nextId: number }).nextId - 1;

  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(prisma, phone);
  const token = captureToken('sms-supervisor-write-commit');
  const goal = `WS-write-commit-goal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const replyText = `Started agent for: ${goal.substring(0, 30)}`;
  const fixture = buildStartNewAgentFixture(goal, replyText, 0.5, 0, 'execute');

  try {
    await setFixtureOverride(userId, fixture);

    const res = await request(`${BASE_URL}/api/sms/inbound`, {
      method: 'POST',
      headers: { 'X-Capture-Token': token },
      body: JSON.stringify({
        data: {
          body: 'Please spawn the test agent',
          conversation: {
            contact: { phone_number: phone },
            phone_number: { number: '+14154498072' },
          },
        },
      }),
    });
    assertStatus(res.status, 200, res.data);

    await waitFor(() => findSurgeCallForReply(token, cursor, phone, replyText));

    const agent = await waitFor(async () => {
      return await prisma.agent.findFirst({ where: { userId, goal } });
    });
    if (!agent) {
      throw new Error('Expected agent row to exist after start_new_agent commit');
    }
    if (agent.priceLimitCents !== 50) {
      throw new Error(
        `Expected priceLimitCents=50 (from budget_dollars=0.5), got ${agent.priceLimitCents}`
      );
    }
    if (agent.source !== 'SMS') {
      throw new Error(`Expected source=SMS for agent spawned by supervisor, got ${agent.source}`);
    }
    if (agent.workflowStartPhase !== 'execute') {
      throw new Error(
        `Expected workflowStartPhase=execute (from start_phase), got ${agent.workflowStartPhase}`
      );
    }

    // Session shape: only the inbound and substantive reply are persisted —
    // not the start_new_agent tool turn. Per WS-1.
    const messages = await waitFor(async () => {
      const session = await prisma.smsSession.findUnique({ where: { userId } });
      if (!session) return null;
      const parsed = JSON.parse(session.messages) as { role?: string; content?: string }[];
      const userCount = parsed.filter((message) => message.role === 'user').length;
      const assistantCount = parsed.filter((message) => message.role === 'assistant').length;
      return userCount === 1 && assistantCount === 1 ? parsed : null;
    });
    const asstMsgs = messages.filter((message) => message.role === 'assistant');
    if (asstMsgs[0].content !== replyText) {
      throw new Error(`Expected only the fixture reply, got: ${JSON.stringify(asstMsgs)}`);
    }
  } finally {
    await cleanupAgentScopedUser(prisma, userId);
  }
}

// ==================== WRITE-TOOL COMMIT FAILURE REPORTING ====================

async function testWriteCommit_failureBuildsUserVisibleError() {
  const op: PendingOp = {
    kind: 'increase_budget',
    args: { agent_id_or_prefix: 'missing-agent', amount_dollars: 10 },
    agentId: 'missing-agent',
  };
  const results = await commitPendingWrites([op], 'missing-user');
  const failures = results.filter((result) => !result.success);
  if (failures.length !== 1) {
    throw new Error(`Expected one failed commit result, got ${JSON.stringify(results)}`);
  }

  const message = buildToolFailureMessage(failures, 'commit');
  if (!message.includes('increase_budget') || !message.includes('no longer exists')) {
    throw new Error(`Expected commit failure details in user-visible message, got: ${message}`);
  }
  if (!message.includes(failures[0].error ?? '')) {
    throw new Error(`Expected exact commit error in user-visible message, got: ${message}`);
  }
  if (/started|completed successfully/i.test(message)) {
    throw new Error(`Failure message must not claim success, got: ${message}`);
  }
}

async function testWriteCommit_increaseBudgetResultIncludesTaskGoal() {
  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(prisma, phone);
  const goal = 'Book the Belo Horizonte dinner reservation and confirm the final guest count';

  try {
    const agent = await prisma.agent.create({
      data: {
        userId,
        goal,
        status: 'COST_LIMIT_REACHED',
        priceLimitCents: 100,
        treeCostCents: 100,
      },
    });
    const op: PendingOp = {
      kind: 'increase_budget',
      args: { agent_id_or_prefix: agent.id.substring(0, 6), amount_dollars: 2 },
      agentId: agent.id,
    };

    const results = await commitPendingWrites([op], userId);
    const result = results[0];
    if (!result?.success) {
      throw new Error(`Expected budget commit to succeed, got ${JSON.stringify(results)}`);
    }
    if (!result.result.includes(goal)) {
      throw new Error(`Expected budget confirmation to include task goal, got: ${result.result}`);
    }
    if (!result.result.includes('$3.00')) {
      throw new Error(`Expected updated budget in confirmation, got: ${result.result}`);
    }

    const updatedAgent = await prisma.agent.findUnique({ where: { id: agent.id } });
    if (updatedAgent?.priceLimitCents !== 300) {
      throw new Error(`Expected priceLimitCents=300, got ${updatedAgent?.priceLimitCents}`);
    }
  } finally {
    await cleanupAgentScopedUser(prisma, userId);
  }
}

// ==================== WS-2 SUPPRESSED-RUN DISCARD — pendingWrites dropped ====================

async function testWs2_suppressedRunDiscardsStartNewAgent() {
  const probeRes = await request(`${BASE_URL}/api/test/captures`);
  if (probeRes.status !== 200) {
    console.warn('  ⚠ capture harness not active — skipping WS-2 discard test');
    return;
  }
  const cursor = (probeRes.data as { nextId: number }).nextId - 1;

  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(prisma, phone);
  const token = captureToken('sms-supervisor-ws2-discard');
  const goal = `WS2-discard-goal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const replyText = `Started agent for: ${goal.substring(0, 30)}`;
  // Keep both supervisor runs inside their LLM call long enough for B's
  // webhook to bump lastInboundSeq before A reaches its commit gate. The
  // shared deploy host can delay timers and socket dispatch by seconds under
  // parallel coverage, so use a bounded contention-safe fixture delay.
  const fixture = buildStartNewAgentFixture(goal, replyText, 0.5, 5_000);
  const firstText = 'WS2 discard — first inbound (suppressed)';
  const secondText = 'WS2 discard — second inbound (committing)';

  try {
    await setFixtureOverride(userId, fixture);

    // The first webhook response is sent only after its inbound sequence was
    // persisted, while its supervisor continues asynchronously. Waiting for
    // that response gives the race a deterministic order without weakening
    // the actual assertion: run A is still in its fixture-delayed LLM call
    // when B advances the sequence and supersedes it.
    const resA = await request(`${BASE_URL}/api/sms/inbound`, {
      method: 'POST',
      headers: { 'X-Capture-Token': token },
      body: JSON.stringify({
        data: {
          body: firstText,
          conversation: {
            contact: { phone_number: phone },
            phone_number: { number: '+14154498072' },
          },
        },
      }),
    });
    assertStatus(resA.status, 200, resA.data);

    const resB = await request(`${BASE_URL}/api/sms/inbound`, {
      method: 'POST',
      headers: { 'X-Capture-Token': token },
      body: JSON.stringify({
        data: {
          body: secondText,
          conversation: {
            contact: { phone_number: phone },
            phone_number: { number: '+14154498072' },
          },
        },
      }),
    });
    assertStatus(resB.status, 200, resB.data);

    await waitFor(() => findSurgeCallForReply(token, cursor, phone, replyText));

    // Let the suppressed run drain past its commit gate so a buggy commit
    // would create a second agent before we assert.
    await new Promise<void>((r) => setTimeout(r, 800));

    // Critical invariant #1: exactly ONE outbound SMS, not two.
    const dedupedReplies = await dedupedSurgeRepliesFor(token, cursor, phone, replyText);
    if (dedupedReplies.length !== 1) {
      throw new Error(
        `Expected exactly one outbound SMS, got ${dedupedReplies.length}: ${dedupedReplies.join(' || ')}`
      );
    }

    // Critical invariant #2: exactly ONE agent created. Both runs queued a
    // start_new_agent op, but the suppressed run must discard its pendingWrites.
    const agents = await prisma.agent.findMany({ where: { userId, goal } });
    if (agents.length !== 1) {
      throw new Error(
        `Expected exactly one agent created from the committing run, got ${agents.length} ` +
          `(provisionalIds: ${agents.map((a) => a.id.substring(0, 6)).join(', ')}). ` +
          `The suppressed run's start_new_agent op should be discarded.`
      );
    }

    const session = await prisma.smsSession.findUnique({ where: { userId } });
    if (!session) {
      throw new Error('Expected SmsSession to exist after WS-2 discard');
    }
    if (session.lastInboundSeq < 2) {
      throw new Error(`Expected lastInboundSeq >= 2, got ${session.lastInboundSeq}`);
    }
  } finally {
    await cleanupAgentScopedUser(prisma, userId);
  }
}

// ==================== RUN ====================

async function runAll() {
  console.log('SMS Supervisor Black-box Tests\n');
  console.log(`Testing against: ${BASE_URL}\n`);

  const tests: { name: string; fn: () => Promise<void> }[] = [
    {
      name: 'context -- recently completed roots stay in SMS hierarchy for 7 days',
      fn: () => assertRecentCompletedRootStaysInHierarchy(prisma),
    },
    ...smsTimezoneBehaviorCases(prisma),
    {
      name: 'smoke -- inbound SMS runs supervisor loop and sends SMS response',
      fn: testSmoke_knownPhoneSupervisorSendsSmsResponse,
    },
    {
      name: 'boundary -- inbound provisions + supervisor captures Surge SMS call',
      fn: testBoundary_inboundCapturesSurgeCall,
    },
    {
      name: 'boundary -- invalid payload produces 0 captures',
      fn: testBoundary_invalidPayloadZeroCaptures,
    },
    {
      name: 'ws2 -- two-inbound race commits only the latest run',
      fn: testWs2_consecutiveInboundCommitsOnlyLatest,
    },
    {
      name: 'write-commit -- start_new_agent applies before user send',
      fn: testWriteCommit_startNewAgentCommitsBeforeUserSend,
    },
    {
      name: 'write-commit -- start_new_agent forwards all 5 object photos (byte-exact)',
      fn: () => testWriteCommit_startNewAgentForwardsInboundImageAttachments(prisma),
    },
    {
      name: 'write-commit -- commit failure produces user-visible error',
      fn: testWriteCommit_failureBuildsUserVisibleError,
    },
    {
      name: 'write-commit -- increase_budget result includes task goal',
      fn: testWriteCommit_increaseBudgetResultIncludesTaskGoal,
    },
    {
      name: 'natural approval -- resolves matching pending request',
      fn: () => testNaturalApproval_resolvesPendingAttentionRequest(prisma),
    },
    {
      name: 'natural approval -- ambiguous approval asks clarification',
      fn: () => testNaturalApproval_ambiguousApprovalAsksClarification(prisma),
    },
    bareRejectionBlackboxCase(prisma),
    ...smsPausedReplyBehaviorCases(prisma),
    ...smsStartPhaseBehaviorCases(prisma),
    ...smsQueuedAgentBehaviorCases(prisma),
    ...smsPhoneAttentionBehaviorCases(prisma),
    {
      name: 'prompt -- supervisor never exposes routing identifiers',
      fn: () => testPrompt_neverExposeRoutingIds(prisma),
    },
    {
      name: 'ws2 -- suppressed run discards queued start_new_agent',
      fn: testWs2_suppressedRunDiscardsStartNewAgent,
    },
    {
      name: 'grep -- inline dispatch succeeds and completion SMS goes out',
      fn: () => testGrep_searchUserDataInlineSuccessCompletes(prisma),
    },
    {
      name: 'grep -- failed dispatch blocks completion and falls back gracefully',
      fn: () => testGrep_failureBlocksCompletionAndFallsBackGracefully(prisma),
    },
    {
      name: 'completion -- rejected until this run sends a user message',
      fn: () => testAttemptCompletion_requiresSuccessfulUserMessage(prisma),
    },
    ...smsDeliveryBehaviorCases(prisma),
    ...smsBluebottleBehaviorCases(prisma),
    {
      name: 'real-llm -- answers contact fact via grep without asking user (opt-in)',
      fn: () => testRealLlm_answersContactFactViaGrep(prisma),
    },
    {
      name: 'real-llm -- clear purchase request spawns agent, no clarifying question (opt-in)',
      fn: () => testRealLlm_purchaseRequestSpawnsAgent(prisma),
    },
    {
      name: 'real-llm -- full stack roundtrip (opt-in via BLACKBOX_SMS_SUPERVISOR_REAL_LLM=1)',
      fn: () => testRealLlm_supervisorRoundTrip(prisma),
    },
    {
      name: 'real-llm -- photo attachment round-trip (opt-in via BLACKBOX_SMS_SUPERVISOR_REAL_LLM=1)',
      fn: () => testRealLlm_photoAttachmentRoundTrip(prisma),
    },
    {
      name: 'real-llm -- 5 object photos blue-recolor spawns agent with all attachments (opt-in)',
      fn: () => testRealLlm_blueRecolorSpawnsAgentWithAllFiveAttachments(prisma),
    },
    {
      name: 'real-llm -- voice note round-trip (opt-in via BLACKBOX_SMS_SUPERVISOR_REAL_LLM=1)',
      fn: () => testRealLlm_voiceNoteRoundTrip(prisma),
    },
  ];

  const results = [];
  for (const t of tests) {
    results.push(await runTest(t.name, t.fn));
  }

  for (const r of results) {
    if (r.passed) {
      console.log(`  PASS  ${r.name} (${r.duration}ms)`);
    } else {
      console.log(`  FAIL  ${r.name} -- ${r.error} (${r.duration}ms)`);
    }
  }

  const failed = results.filter((r) => !r.passed);
  console.log(
    `\nResults: ${results.length - failed.length} passed, ${failed.length} failed, ${results.length} total`
  );

  await prisma.$disconnect();

  if (failed.length > 0) {
    process.exit(1);
  }
}

runAll().catch((err) => {
  console.error('Test run failed:', err);
  process.exit(1);
});
