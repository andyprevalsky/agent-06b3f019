import '../blackbox/assertLocalDatabase';
import assert from 'node:assert/strict';
import express from 'express';
import { retryWithBackoff } from '../../providers/retry';
import { registerBrowserNavigationRoutes } from '../../domains/browser-session/routes.navigation';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import {
  BrowserNavigationError,
  claimBrowserNavigation,
  completeBrowserNavigation,
  navigateBrowser,
} from '../../domains/browser-session/service.navigation';
import { SessionNotFoundError } from '../../domains/browser-session/service.local-storage';

async function run() {
  const userId = `navigation-${randomUUID()}`;
  const context = await prisma.browserContext.create({ data: { userId } });
  const session = await prisma.browserSession.create({
    data: {
      contextId: context.id,
      agentId: randomUUID(),
      sessionId: randomUUID(),
      controlState: 'USER',
      controlLeaseExpiresAt: new Date(Date.now() + 90000),
      provider: 'tilion',
    },
  });
  const taskId = session.id,
    sessionId = session.sessionId!;
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerBrowserNavigationRoutes(router);
  app.use('/api/browser-session', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('No server address');
  const endpoint = `http://127.0.0.1:${address.port}/api/browser-session/task/${taskId}/navigation`;
  const oldKey = process.env.BACKEND_API_KEY;
  process.env.BACKEND_API_KEY = 'navigation-regression-key';
  const post = (action: string, authenticated = true) =>
    fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authenticated ? { 'x-api-key': 'navigation-regression-key' } : {}),
      },
      body: JSON.stringify({ action }),
    });
  try {
    assert.equal((await post('back', false)).status, 401);
    assert.equal((await post('guess-url')).status, 400);
    await assert.rejects(navigateBrowser(taskId, 'back', 'foreign'), SessionNotFoundError);
    assert.equal(await claimBrowserNavigation(taskId, 'old-session'), null);
    const result = post('back').then(async (response) => {
      assert.equal(response.status, 200);
      return response.json();
    });
    const claimed = await retryWithBackoff(() => claimBrowserNavigation(taskId, sessionId), {
      maxRetries: 100,
      fixedDelays: Array(100).fill(5) as number[],
      shouldRetryResult: (result) => result === null,
    });
    assert.ok(claimed);
    assert.equal(claimed.action, 'back');
    assert.equal(await claimBrowserNavigation(taskId, sessionId), null, 'claim must be single-use');
    await assert.rejects(navigateBrowser(taskId, 'forward', userId), /already in progress/);
    await assert.rejects(
      completeBrowserNavigation(taskId, 'old-session', claimed.id, { url: 'wrong' }),
      BrowserNavigationError
    );
    await completeBrowserNavigation(taskId, sessionId, claimed.id, {
      url: 'https://example.test/back',
    });
    assert.deepEqual(await result, { url: 'https://example.test/back' });
    await assert.rejects(
      completeBrowserNavigation(taskId, sessionId, claimed.id, { url: 'replay' }),
      BrowserNavigationError
    );
    // A replacement session cannot receive the old command or its completion.
    await prisma.browserSession.update({
      where: { id: taskId },
      data: { sessionId: randomUUID(), navigationCommand: { ...claimed, state: 'pending' } },
    });
    assert.equal(await claimBrowserNavigation(taskId, sessionId), null);
    await assert.rejects(
      completeBrowserNavigation(taskId, sessionId, claimed.id, { url: 'stale' }),
      BrowserNavigationError
    );
    await prisma.browserSession.update({ where: { id: taskId }, data: { controlState: 'AGENT' } });
    await assert.rejects(navigateBrowser(taskId, 'back', userId), /Take control/);
    process.stdout.write(
      'PASS browser navigation: owner, same session, single claim, busy, receipt, stale, control'
    );
  } finally {
    if (oldKey === undefined) delete process.env.BACKEND_API_KEY;
    else process.env.BACKEND_API_KEY = oldKey;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.browserContext.delete({ where: { id: context.id } });
  }
}
run()
  .finally(() => prisma.$disconnect())
  .catch((error) => {
    process.stderr.write(String(error));
    process.exitCode = 1;
  });
