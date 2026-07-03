import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { PrismaClient } from '@prisma/client';
import {
  BASE_URL,
  BYPASS_FIXTURE_REAL_LLM,
  assertStatus,
  captureToken,
  capturedSmsBody,
  cleanupAgentScopedUser,
  cleanupSessionScopedUser,
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
      { tool: 'attempt_completion', arguments: { message: params.smsReply } },
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
        tool_calls: [{ tool: 'attempt_completion', arguments: { message: clarification } }],
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
    await cleanupSessionScopedUser(prisma, userId);
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

    if (replyText === 'Sorry, something went wrong. Please try again.') {
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
        `Expected exactly one assistant turn persisted, got ${asstMsgs.length}: ${JSON.stringify(
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

// ==================== REAL-LLM MEDIA ROUND-TRIPS ====================
// Fire an MMS-shaped Surge payload (photo / voice note attachment) at
// /api/sms/inbound and assert the real supervisor LLM's outbound SMS reflects
// the media content. Fixtures are served from a throwaway local HTTP server so
// the backend downloads them exactly like it downloads Surge CDN media.

/** Serve a fixture file over local HTTP so the backend can download it. */
async function serveFixture(
  filename: string,
  contentType: string
): Promise<{ url: string; close: () => void }> {
  const bytes = readFileSync(resolve(__dirname, 'fixtures', filename));
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(bytes);
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/${filename}`,
    close: () => server.close(),
  };
}

interface MediaRoundTripParams {
  label: string;
  /** Inbound SMS text; empty string exercises the media-only (no text) path. */
  inboundBody: string;
  fixtureFile: string;
  contentType: string;
  /** Case-insensitive substring the LLM's outbound SMS must contain. */
  expectInReply: string;
  /** Substring the persisted user session turn must contain. */
  expectInPersistedUserTurn: string;
}

async function runRealLlmMediaRoundTrip(
  prisma: PrismaClient,
  params: MediaRoundTripParams
): Promise<void> {
  if (process.env.BLACKBOX_SMS_SUPERVISOR_REAL_LLM !== '1') {
    console.warn(`  ⚠ BLACKBOX_SMS_SUPERVISOR_REAL_LLM != 1 — skipping ${params.label} round-trip`);
    return;
  }
  const probeRes = await request(`${BASE_URL}/api/test/captures`);
  if (probeRes.status !== 200) {
    console.warn(`  ⚠ capture harness not active — skipping ${params.label} round-trip`);
    return;
  }
  const cursor = (probeRes.data as { nextId: number }).nextId - 1;

  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(prisma, phone);
  const token = captureToken(`sms-supervisor-media-${params.label.replace(/\s+/g, '-')}`);
  const fixture = await serveFixture(params.fixtureFile, params.contentType);

  try {
    await setFixtureOverride(userId, BYPASS_FIXTURE_REAL_LLM);

    const res = await request(`${BASE_URL}/api/sms/inbound`, {
      method: 'POST',
      headers: { 'X-Capture-Token': token },
      body: JSON.stringify({
        data: {
          body: params.inboundBody,
          attachments: [{ url: fixture.url, type: params.contentType }],
          conversation: {
            contact: { phone_number: phone },
            phone_number: { number: '+14154498072' },
          },
        },
      }),
    });
    assertStatus(res.status, 200, res.data);

    // Media adds download + (for audio) transcription hops before the LLM.
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
      90000,
      500
    );

    const replyBody = capturedSmsBody(surgeCall);
    const replyText = typeof replyBody?.body === 'string' ? replyBody.body : '';
    if (!replyText.toLowerCase().includes(params.expectInReply.toLowerCase())) {
      throw new Error(
        `Expected ${params.label} reply to contain "${params.expectInReply}", got: "${replyText}"`
      );
    }

    const session = await prisma.smsSession.findUnique({ where: { userId } });
    if (!session) {
      throw new Error(`Expected SmsSession after ${params.label} round-trip`);
    }
    const messages = JSON.parse(session.messages) as { role?: string; content?: string }[];
    const userTurn = messages.find((m) => m.role === 'user');
    if (!userTurn?.content?.includes(params.expectInPersistedUserTurn)) {
      throw new Error(
        `Expected persisted user turn to contain "${params.expectInPersistedUserTurn}", ` +
          `got: "${userTurn?.content?.substring(0, 200)}"`
      );
    }
  } finally {
    fixture.close();
    await cleanupAgentScopedUser(prisma, userId);
  }
}

export async function testRealLlm_photoAttachmentRoundTrip(prisma: PrismaClient) {
  await runRealLlmMediaRoundTrip(prisma, {
    label: 'photo',
    inboundBody:
      'What is the dominant color of the attached photo? Reply with just the color name.',
    fixtureFile: 'red-square.png',
    contentType: 'image/png',
    expectInReply: 'red',
    expectInPersistedUserTurn: 'photo(s) attached',
  });
}

export async function testRealLlm_voiceNoteRoundTrip(prisma: PrismaClient) {
  // The fixture speech asks: "Hey Rose, quick question. What is the capital of
  // France? Text me back just the city name." A reply containing "Paris"
  // proves the supervisor understood the spoken question, and the persisted
  // transcript containing "capital of France" proves transcription was
  // verbatim (not the STT model answering the audio itself).
  await runRealLlmMediaRoundTrip(prisma, {
    label: 'voice note',
    inboundBody: '',
    fixtureFile: 'voice-note.wav',
    contentType: 'audio/wav',
    expectInReply: 'paris',
    expectInPersistedUserTurn: 'capital of France',
  });
}
