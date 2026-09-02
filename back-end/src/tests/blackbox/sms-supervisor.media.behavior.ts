import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import {
  BASE_URL,
  BYPASS_FIXTURE_REAL_LLM,
  assertStatus,
  buildStartNewAgentFixture,
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

// Fire an MMS-shaped Surge payload (photo / voice note attachment) at
// /api/sms/inbound and assert the real supervisor LLM's outbound SMS reflects
// the media content. Fixtures are served from a throwaway local HTTP server so
// the backend downloads them exactly like it downloads Surge CDN media.

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
  inboundBody: string;
  fixtureFile: string;
  contentType: string;
  expectInReply: string;
  expectedPersistedUserTurn: string;
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
    const userTurns = messages.filter((m) => m.role === 'user');
    if (userTurns.length !== 1 || userTurns[0].content !== params.expectedPersistedUserTurn) {
      throw new Error(
        `Expected one canonical persisted user turn "${params.expectedPersistedUserTurn}", ` +
          `got: ${JSON.stringify(userTurns.map((turn) => turn.content))}`
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
    expectedPersistedUserTurn:
      'What is the dominant color of the attached photo? Reply with just the color name.\n\n[1 attachment(s)]',
  });
}

export async function testRealLlm_voiceNoteRoundTrip(prisma: PrismaClient) {
  await runRealLlmMediaRoundTrip(prisma, {
    label: 'voice note',
    inboundBody: '',
    fixtureFile: 'voice-note.wav',
    contentType: 'audio/wav',
    expectInReply: 'paris',
    expectedPersistedUserTurn: '[1 attachment(s)]',
  });
}

/**
 * RCA repro: inbound MMS image(s) must be uploaded and attached as USER
 * `filePointer` messages on the agent created by `start_new_agent`.
 *
 * Prod evidence (agent 6ea9cd1e…): SMS session had `[7 attachment(s)]`, the
 * supervisor called start_new_agent for mirror-stain cleanup, and every agent
 * message landed with `filePointer: null` — so the create path never received
 * the files.
 */
export async function testWriteCommit_startNewAgentForwardsInboundImageAttachments(
  prisma: PrismaClient
): Promise<void> {
  const probeRes = await request(`${BASE_URL}/api/test/captures`);
  if (probeRes.status !== 200) {
    console.warn('  ⚠ capture harness not active — skipping MMS→create attachment forward test');
    return;
  }
  const cursor = (probeRes.data as { nextId: number }).nextId - 1;

  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(prisma, phone);
  const token = captureToken('sms-supervisor-mms-forward-create');
  const goal = `WS-mms-forward-goal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const replyText = `Started agent for: ${goal.substring(0, 30)}`;
  const fixture = buildStartNewAgentFixture(goal, replyText, 0.5);
  const media = await serveFixture('red-square.png', 'image/png');

  try {
    await setFixtureOverride(userId, fixture);

    const res = await request(`${BASE_URL}/api/sms/inbound`, {
      method: 'POST',
      headers: { 'X-Capture-Token': token },
      body: JSON.stringify({
        data: {
          body: 'Clean the stains in the attached photo',
          attachments: [{ url: media.url, type: 'image/png' }],
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

    const attachmentMessages = await prisma.message.findMany({
      where: {
        agentId: agent.id,
        role: 'USER',
        NOT: { filePointer: { equals: null } },
      },
    });
    if (attachmentMessages.length < 1) {
      throw new Error(
        `Expected start_new_agent to forward inbound MMS as USER filePointer message(s); ` +
          `got ${attachmentMessages.length} attachment messages on agent ${agent.id}`
      );
    }

    const pointer = attachmentMessages[0].filePointer as {
      mime_type?: string;
      original_filename?: string;
      storage_path?: string;
    } | null;
    if (!pointer || typeof pointer !== 'object') {
      throw new Error(`Expected filePointer object, got: ${JSON.stringify(pointer)}`);
    }
    if (pointer.mime_type !== 'image/png') {
      throw new Error(`Expected mime_type=image/png, got: ${JSON.stringify(pointer)}`);
    }
    if (!pointer.storage_path || !pointer.original_filename) {
      throw new Error(
        `Expected storage_path + original_filename on forwarded attachment, got: ${JSON.stringify(pointer)}`
      );
    }
  } finally {
    media.close();
    await cleanupAgentScopedUser(prisma, userId);
  }
}
