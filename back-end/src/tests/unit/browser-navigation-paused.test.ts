import '../blackbox/assertLocalDatabase';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { prisma } from '../../providers/database';
import { hasDetachedAuthWorker } from '../../domains/browser-session/repo.navigation';
import { navigateBrowser } from '../../domains/browser-session/service.navigation';

async function run() {
  const userId = `paused-nav-${randomUUID()}`;
  await prisma.user.create({ data: { userId } });
  const agent = await prisma.agent.create({
    data: { userId, goal: 'navigation regression', status: 'PAUSED' },
  });
  const context = await prisma.browserContext.create({ data: { userId } });
  const session = await prisma.browserSession.create({
    data: {
      agentId: agent.id,
      contextId: context.id,
      sessionId: randomUUID(),
      wsUrl: 'ws://navigation-test.invalid/expired',
      provider: 'tilion',
      controlState: 'USER',
      controlLeaseExpiresAt: new Date(Date.now() + 90000),
    },
  });
  const sessionId = session.sessionId!;
  const requestId = randomUUID();
  const original = chromium.connectOverCDP;
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.TILION_API_KEY;
  process.env.TILION_API_KEY = 'navigation-test-key';
  let replacedDuringRefresh = false;
  globalThis.fetch = (async (input) => {
    assert.ok(String(input).includes('/connect'));
    if (replacedDuringRefresh)
      await prisma.browserSession.update({
        where: { id: session.id },
        data: { sessionId: 'replacement' },
      });
    return new Response(JSON.stringify({ connect_url: 'ws://navigation-test.invalid/fresh' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  let connects = 0,
    actions = 0,
    resumesDuringConnect = false;
  chromium.connectOverCDP = (async (url) => {
    assert.equal(
      url,
      'ws://navigation-test.invalid/fresh',
      'must use freshly minted Tilion connect token'
    );
    connects++;
    if (resumesDuringConnect)
      await prisma.agent.update({ where: { id: agent.id }, data: { status: 'ACTIVE' } });
    return {
      contexts: () => [
        {
          pages: () => [
            {
              evaluate: async () => ({ focused: true, visible: true }),
              goBack: async () => {
                actions++;
              },
              url: () => 'https://history.test/back',
            },
          ],
        },
      ],
      close: async () => undefined,
    };
  }) as unknown as typeof chromium.connectOverCDP;
  const detached = () => hasDetachedAuthWorker(session.id, sessionId, agent.id, userId);
  try {
    assert.equal(await detached(), false, 'PAUSED alone is not release evidence');
    await prisma.agentAttentionRequest.create({
      data: {
        id: requestId,
        userId,
        agentId: agent.id,
        workflowId: 'test-workflow',
        question: 'Sign in',
      },
    });
    await prisma.userAuthAssistanceRequest.create({
      data: {
        id: requestId,
        userId,
        agentId: agent.id,
        authRealm: 'example.test',
        browserSessionId: session.id,
        steelSessionId: sessionId,
        mode: 'live_view',
      },
    });
    assert.equal(await detached(), false, 'an unanswered request alone precedes CDP detach');
    await prisma.message.create({
      data: {
        agentId: agent.id,
        role: 'ASSISTANT',
        text: 'Auth handoff',
        metadata: {
          action_type: 'auth_assistance',
          browser_page_observation: {
            phase: 'park_time',
            task_id: session.id,
            session_id: sessionId,
            request_id: requestId,
          },
        },
      },
    });
    assert.equal(await detached(), true);
    assert.equal(await hasDetachedAuthWorker(session.id, 'replacement', agent.id, userId), false);
    assert.deepEqual(await navigateBrowser(session.id, 'back', userId), {
      url: 'https://history.test/back',
    });
    assert.equal(connects, 1);
    assert.equal(actions, 1, 'detached auth browser navigates directly without a mailbox timeout');
    resumesDuringConnect = true;
    await assert.rejects(navigateBrowser(session.id, 'back', userId), /ownership changed/);
    assert.equal(actions, 1, 'resuming worker must prevent direct browser action');
    assert.equal(await detached(), false, 'ACTIVE owner can never use old release evidence');
    await prisma.agent.update({ where: { id: agent.id }, data: { status: 'PAUSED' } });
    replacedDuringRefresh = true;
    const connectsBeforeReplacement = connects;
    await assert.rejects(navigateBrowser(session.id, 'back', userId), /session changed/);
    assert.equal(
      connects,
      connectsBeforeReplacement,
      'session replacement during token refresh prevents connecting'
    );
    await prisma.browserSession.update({ where: { id: session.id }, data: { sessionId } });
    replacedDuringRefresh = false;
    await prisma.agentAttentionRequest.update({
      where: { id: requestId },
      data: { userResponse: 'done' },
    });
    assert.equal(await detached(), false, 'answered auth request invalidates release evidence');
    process.stdout.write(
      'PASS paused auth navigation, absent proof, stale binding, resume race, completed request\n'
    );
  } finally {
    chromium.connectOverCDP = original;
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TILION_API_KEY;
    else process.env.TILION_API_KEY = originalKey;
    await prisma.agentAttentionRequest.deleteMany({ where: { id: requestId } });
    await prisma.browserContext.delete({ where: { id: context.id } });
    await prisma.agent.delete({ where: { id: agent.id } });
    await prisma.user.delete({ where: { userId } });
  }
}
run()
  .finally(() => prisma.$disconnect())
  .catch((error) => {
    process.stderr.write(String(error));
    process.exitCode = 1;
  });
