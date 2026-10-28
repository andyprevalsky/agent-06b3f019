import assert from 'node:assert/strict';
// Called inside the registered first-init subprocess fixture after its provider
// doubles are installed; this module is not a standalone blackbox entrypoint.
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request } from 'node:http';
import express, { type Response } from 'express';
import { prisma } from '../../providers/database';
import { logicalBrowserTaskId } from '../../providers/browser/logicalSession';

export async function runBrowserInitAdoptionCases(
  userId: string,
  startUrl: string,
  setCommitHook: (hook: ((operationKey?: string) => Promise<void>) | undefined) => void
): Promise<string[]> {
  const { registerBrowserInitRoute } = await import('../../domains/browser-session/routes.init');
  const failures: string[] = [];
  for (const adopt of [false, true]) {
    const agentId = randomUUID();
    const taskId = logicalBrowserTaskId(agentId);
    await prisma.agent.create({
      data: { id: agentId, userId, goal: 'initial allocation adoption' },
    });
    let committed!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      committed = resolve;
    });
    const ack = new Promise<void>((resolve) => {
      release = resolve;
    });
    setCommitHook(async (key) => {
      if (key !== undefined && key !== `browser-initialization:${taskId}`) return;
      const receipt = await prisma.toolSideEffect.findUnique({
        where: { operationKey: `browser-initialization:${taskId}` },
      });
      if (receipt?.status !== 'SUCCEEDED') return;
      setCommitHook(undefined);
      committed();
      await ack;
    });
    const app = express();
    app.use(express.json());
    let initialResponse: Response | undefined;
    let closed!: () => void;
    const disconnected = new Promise<void>((resolve) => {
      closed = resolve;
    });
    app.use((req, res, next) => {
      if (req.headers['x-fixture-initial'] === '1') {
        initialResponse = res;
        res.once('close', closed);
      }
      next();
    });
    const router = express.Router();
    registerBrowserInitRoute(router, (req, _res, next) => {
      Object.assign(req, { isInternal: true });
      next();
    });
    app.use('/api/browser-session', router);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    const body = JSON.stringify({ user_id: userId, agent_id: agentId, start_url: startUrl });
    const initial = request({
      hostname: '127.0.0.1',
      port: address.port,
      path: '/api/browser-session/init',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-fixture-initial': '1',
      },
    });
    initial.on('error', () => undefined);
    initial.end(body);
    try {
      await ready;
      if (adopt) {
        const response = await fetch(`http://127.0.0.1:${address.port}/api/browser-session/init`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        });
        assert.equal(response.status, 200);
        const borrowed = (await response.json()) as { same_session_available: boolean };
        assert.equal(borrowed.same_session_available, true);
      }
      initial.destroy();
      await disconnected;
      assert.equal(initialResponse?.writableFinished, false, 'real unfinished response required');
      release();
      // Let the actual asynchronous route finish its exact cleanup operation.
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      const row = await prisma.browserSession.findUniqueOrThrow({ where: { id: taskId } });
      if (row.status !== 'ACTIVE')
        failures.push(
          adopt
            ? 'allocator closed adopted browser'
            : 'allocator closed prepared persistent browser'
        );
    } finally {
      release();
      setCommitHook(undefined);
      initial.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  }
  return failures;
}
