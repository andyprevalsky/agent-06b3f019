#!/usr/bin/env tsx
/** Browser-process keyboard route: auth, validation, ownership, and provider response. */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { prisma } from '../../providers/database';

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function main(): Promise<void> {
  const previousApiKey = process.env.BACKEND_API_KEY;
  const apiKey = previousApiKey?.trim() || `computer-input-${randomUUID()}`;
  process.env.BACKEND_API_KEY = apiKey;

  const { default: browserSessionRouter } = await import('../../domains/browser-session/routes');
  const app = express();
  app.use(express.json());
  app.use('/api/browser-session', browserSessionRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  const userId = `computer-input-owner-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  const context = await prisma.browserContext.create({ data: { userId } });
  const session = await prisma.browserSession.create({
    data: {
      contextId: context.id,
      agentId: randomUUID(),
      sessionId: `steel-computer-input-${randomUUID()}`,
      provider: 'steel',
      status: 'ACTIVE',
    },
  });
  const endpoint = `http://127.0.0.1:${port}/api/browser-session/${session.sessionId}/computer/press-key`;

  const post = async (headers: Record<string, string>, body: unknown) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  try {
    assert.equal((await post({}, { keys: ['Escape'] })).status, 401);
    assert.equal(
      (await post({ 'x-api-key': apiKey }, { keys: ['Escape'] })).status,
      401,
      'an internal caller must propagate the run user instead of bypassing ownership'
    );
    assert.equal(
      (await post({ 'x-api-key': apiKey, 'x-user-id': userId }, { keys: [] })).status,
      400
    );
    assert.equal(
      (
        await post(
          { 'x-api-key': apiKey, 'x-user-id': `foreign-${randomUUID()}` },
          { keys: ['Escape'] }
        )
      ).status,
      404,
      'a foreign owner must not reach provider input'
    );
    const ownSession = await post(
      { 'x-api-key': apiKey, 'x-user-id': userId },
      { keys: ['Escape'] }
    );
    assert.equal(ownSession.status, 200);
    assert.deepEqual(ownSession.body, {
      provider: 'steel',
      supported: false,
      pressed: false,
    });
  } finally {
    await prisma.browserSession.delete({ where: { id: session.id } }).catch(() => undefined);
    await prisma.browserContext.delete({ where: { id: context.id } }).catch(() => undefined);
    await prisma.user.delete({ where: { userId } }).catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    await closeServer(server);
    if (previousApiKey === undefined) delete process.env.BACKEND_API_KEY;
    else process.env.BACKEND_API_KEY = previousApiKey;
  }

  process.stdout.write('PASS browser-session computer input route (5 cases)\n');
}

main().catch(async (error: unknown) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${detail}\n`);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
