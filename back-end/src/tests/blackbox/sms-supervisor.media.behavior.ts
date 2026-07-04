import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import {
  BASE_URL,
  BYPASS_FIXTURE_REAL_LLM,
  assertStatus,
  captureToken,
  capturedSmsBody,
  cleanupAgentScopedUser,
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
  await runRealLlmMediaRoundTrip(prisma, {
    label: 'voice note',
    inboundBody: '',
    fixtureFile: 'voice-note.wav',
    contentType: 'audio/wav',
    expectInReply: 'paris',
    expectInPersistedUserTurn: 'capital of France',
  });
}
