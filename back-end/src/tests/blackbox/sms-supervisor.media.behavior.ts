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

/** Serve multiple distinct fixture files from one local HTTP server (path = filename). */
async function serveFixtureFiles(
  filenames: string[],
  contentType: string
): Promise<{ baseUrl: string; close: () => void }> {
  const files = new Map(
    filenames.map((filename) => [
      `/${filename}`,
      readFileSync(resolve(__dirname, 'fixtures', filename)),
    ])
  );
  const server = createServer((req, res) => {
    const pathOnly = (req.url ?? '/').split('?')[0] ?? '/';
    const bytes = files.get(pathOnly);
    if (!bytes) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(bytes);
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
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
 * Cement: 5 distinct non-blue object photos (synthetic fixtures — never user
 * phone photos) are forwarded onto start_new_agent create, and each FilePointer
 * is downloadable with the exact bytes the SMS inbound served. Goal text asks
 * for blue recolors so this mirrors the product path without depending on a
 * live agent worker for the create-boundary assert.
 *
 * Prod evidence (agent 6ea9cd1e…): SMS session had `[7 attachment(s)]` but
 * create landed with `filePointer: null`.
 */
const BLUE_RECOLOR_OBJECT_FIXTURES = [
  'object-apple.png',
  'object-banana.png',
  'object-leaf.png',
  'object-orange.png',
  'object-grape.png',
] as const;

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
  const goal =
    'Recolor every attached photo so the object is blue. Keep shape and background; ' +
    `return one blue version per input. marker=${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const replyText = `Started agent for: ${goal.substring(0, 30)}`;
  const fixture = buildStartNewAgentFixture(goal, replyText, 0.5);
  const imageCount = BLUE_RECOLOR_OBJECT_FIXTURES.length;
  const media = await serveFixtureFiles([...BLUE_RECOLOR_OBJECT_FIXTURES], 'image/png');
  const sourceBytes = new Map(
    BLUE_RECOLOR_OBJECT_FIXTURES.map((filename) => [
      filename,
      readFileSync(resolve(__dirname, 'fixtures', filename)),
    ])
  );
  const attachments = BLUE_RECOLOR_OBJECT_FIXTURES.map((filename) => ({
    url: `${media.baseUrl}/${filename}`,
    type: 'image/png',
  }));

  try {
    await setFixtureOverride(userId, fixture);

    const res = await request(`${BASE_URL}/api/sms/inbound`, {
      method: 'POST',
      headers: { 'X-Capture-Token': token },
      body: JSON.stringify({
        data: {
          body: 'Make blue versions of all 5 attached photos (apple, banana, leaf, orange, grape).',
          attachments,
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
      orderBy: { timestamp: 'asc' },
    });
    if (attachmentMessages.length !== imageCount) {
      throw new Error(
        `Expected start_new_agent to forward all ${imageCount} inbound MMS images as USER ` +
          `filePointer messages; got ${attachmentMessages.length} on agent ${agent.id}`
      );
    }

    const { getFileContent } = await import('../../providers/storage');
    const storagePaths = new Set<string>();
    const matchedSources = new Set<string>();
    for (const message of attachmentMessages) {
      const pointer = message.filePointer as {
        mime_type?: string;
        original_filename?: string;
        storage_path?: string;
        size_bytes?: number;
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
      storagePaths.add(pointer.storage_path);

      const downloaded = await getFileContent({
        id: '00000000-0000-0000-0000-000000000000',
        storage_path: pointer.storage_path,
        original_filename: pointer.original_filename,
        mime_type: pointer.mime_type,
        size_bytes: pointer.size_bytes ?? 0,
        created_at: new Date().toISOString(),
      });
      let matched: string | null = null;
      for (const [filename, bytes] of sourceBytes) {
        if (bytes.equals(downloaded)) {
          matched = filename;
          break;
        }
      }
      if (!matched) {
        throw new Error(
          `Downloaded attachment ${pointer.original_filename} (${downloaded.length} bytes) ` +
            `did not match any of the 5 source object fixtures — create cannot use the real files`
        );
      }
      matchedSources.add(matched);
    }
    if (storagePaths.size !== imageCount) {
      throw new Error(
        `Expected ${imageCount} distinct storage_path values, got ${storagePaths.size}`
      );
    }
    if (matchedSources.size !== imageCount) {
      throw new Error(
        `Expected all ${imageCount} source fixtures on the agent, matched: ${[...matchedSources].join(', ')}`
      );
    }
  } finally {
    media.close();
    await cleanupAgentScopedUser(prisma, userId);
  }
}

/**
 * Opt-in real-LLM: SMS "make these 5 photos blue" must spawn an agent that
 * receives all 5 FilePointers (create-boundary + supervisor tool choice).
 */
export async function testRealLlm_blueRecolorSpawnsAgentWithAllFiveAttachments(
  prisma: PrismaClient
): Promise<void> {
  if (process.env.BLACKBOX_SMS_SUPERVISOR_REAL_LLM !== '1') {
    console.warn(
      '  ⚠ BLACKBOX_SMS_SUPERVISOR_REAL_LLM != 1 — skipping real-LLM 5-image blue-recolor spawn'
    );
    return;
  }
  const probeRes = await request(`${BASE_URL}/api/test/captures`);
  if (probeRes.status !== 200) {
    console.warn('  ⚠ capture harness not active — skipping real-LLM 5-image blue-recolor spawn');
    return;
  }

  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(prisma, phone);
  const token = captureToken('sms-supervisor-real-llm-blue-recolor-5');
  const media = await serveFixtureFiles([...BLUE_RECOLOR_OBJECT_FIXTURES], 'image/png');
  const attachments = BLUE_RECOLOR_OBJECT_FIXTURES.map((filename) => ({
    url: `${media.baseUrl}/${filename}`,
    type: 'image/png',
  }));

  try {
    await setFixtureOverride(userId, BYPASS_FIXTURE_REAL_LLM);

    const res = await request(`${BASE_URL}/api/sms/inbound`, {
      method: 'POST',
      headers: { 'X-Capture-Token': token },
      body: JSON.stringify({
        data: {
          body:
            'Please start an agent to recolor every attached photo so the object is blue. ' +
            'There are 5 photos (apple, banana, leaf, orange, grape). Do not ask clarifying questions.',
          attachments,
          conversation: {
            contact: { phone_number: phone },
            phone_number: { number: '+14154498072' },
          },
        },
      }),
    });
    assertStatus(res.status, 200, res.data);

    const agent = await waitFor(
      async () => prisma.agent.findFirst({ where: { userId, source: 'SMS' } }),
      120000,
      2000
    );
    if (!agent) {
      throw new Error(
        'Expected real-LLM supervisor to call start_new_agent for the 5-image blue-recolor request'
      );
    }
    const goal = agent.goal.toLowerCase();
    if (!/blue|recolor|color/.test(goal)) {
      throw new Error(`Expected agent goal to mention blue/recolor, got: "${agent.goal}"`);
    }

    const attachmentMessages = await prisma.message.findMany({
      where: {
        agentId: agent.id,
        role: 'USER',
        NOT: { filePointer: { equals: null } },
      },
    });
    if (attachmentMessages.length !== BLUE_RECOLOR_OBJECT_FIXTURES.length) {
      throw new Error(
        `Expected ${BLUE_RECOLOR_OBJECT_FIXTURES.length} FilePointers on spawned agent, ` +
          `got ${attachmentMessages.length} (agent ${agent.id})`
      );
    }
  } finally {
    media.close();
    await cleanupAgentScopedUser(prisma, userId);
  }
}
