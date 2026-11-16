import '../blackbox/assertLocalDatabase';
import assert from 'node:assert/strict';
import express from 'express';
import { retryWithBackoff } from '../../providers/retry';
import { registerBrowserNavigationRoutes } from '../../domains/browser-session/routes.navigation';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { Prisma } from '@prisma/client';
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
    const replacementSessionId = randomUUID();
    await prisma.browserSession.update({
      where: { id: taskId },
      data: {
        sessionId: replacementSessionId,
        navigationCommand: { ...claimed, state: 'pending' },
      },
    });
    assert.equal(await claimBrowserNavigation(taskId, sessionId), null);
    await assert.rejects(
      completeBrowserNavigation(taskId, sessionId, claimed.id, { url: 'stale' }),
      BrowserNavigationError
    );
    // Mailbox path (agent is not the root browser, no detached worker): the
    // replacement session's worker never answers, so the deadline ends the wait.
    const settledWithin = (pending: Promise<unknown>, ms: number) =>
      Promise.race([
        pending.then(
          () => 'settled',
          () => 'settled'
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve('pending'), ms)),
      ]);
    const storedCommand = async () =>
      (
        await prisma.browserSession.findUniqueOrThrow({
          where: { id: taskId },
          select: { navigationCommand: true },
        })
      ).navigationCommand;
    const commandWritten = () =>
      retryWithBackoff(storedCommand, {
        maxRetries: 200,
        fixedDelays: Array(200).fill(10) as number[],
        shouldRetryResult: (stored) => stored === null,
      });
    await prisma.browserSession.update({
      where: { id: taskId },
      data: { navigationCommand: Prisma.DbNull },
    });
    const timedOut = navigateBrowser(taskId, 'reload', userId);
    await commandWritten();
    assert.equal(await settledWithin(timedOut, 300), 'pending', 'waits for the worker receipt');
    const realNow = Date.now;
    Date.now = () => realNow() + 15_001;
    try {
      assert.equal(
        await settledWithin(timedOut, 2_000),
        'settled',
        'the navigation deadline must end the wait promptly'
      );
      await assert.rejects(
        timedOut,
        (error: unknown) =>
          error instanceof BrowserNavigationError &&
          error.status === 504 &&
          error.message === 'Browser worker did not complete navigation before the deadline'
      );
      const expired = (await storedCommand()) as { state: string } | null;
      assert.equal(expired?.state, 'pending', 'a timed-out wait leaves the command unanswered');
      assert.equal(await claimBrowserNavigation(taskId, replacementSessionId), null);
    } finally {
      Date.now = realNow;
    }
    // A worker that reports failure surfaces as a 502 with the worker's message.
    await prisma.browserSession.update({
      where: { id: taskId },
      data: { navigationCommand: Prisma.DbNull },
    });
    const failed = navigateBrowser(taskId, 'back', userId);
    const failedClaim = await retryWithBackoff(
      () => claimBrowserNavigation(taskId, replacementSessionId),
      {
        maxRetries: 200,
        fixedDelays: Array(200).fill(10) as number[],
        shouldRetryResult: (result) => result === null,
      }
    );
    assert.ok(failedClaim);
    await completeBrowserNavigation(taskId, replacementSessionId, failedClaim.id, {
      url: null,
      error: 'x',
    });
    await assert.rejects(
      failed,
      (error: unknown) =>
        error instanceof BrowserNavigationError &&
        error.status === 502 &&
        error.message === 'Browser worker navigation failed'
    );
    await prisma.browserSession.update({ where: { id: taskId }, data: { controlState: 'AGENT' } });
    await assert.rejects(navigateBrowser(taskId, 'back', userId), /Take control/);
    process.stdout.write(
      'PASS browser navigation: owner, same session, single claim, busy, receipt, stale, deadline 504, worker error 502, control'
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
