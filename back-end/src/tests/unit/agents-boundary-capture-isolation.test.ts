#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { type AddressInfo } from 'node:net';
import { installFetchCapture, captureTokenMiddleware } from '../../providers/fetchCapture';

async function run(): Promise<void> {
  const nativeFetch = globalThis.fetch;
  const upstreamTokens: string[] = [];
  let invalidPosts = 0;
  let emitMatchingCall = false;
  const app = express();
  app.use(express.json());
  app.use(captureTokenMiddleware);
  // Only the external transport is fake. Local HTTP, capture publication,
  // token propagation, and the registered boundary case are real.
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).hostname === 'openrouter.ai') {
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    }
    assert.equal(new URL(url).hostname, '127.0.0.1', 'No external network allowed');
    return nativeFetch(input, init);
  };
  process.env.BLACKBOX_TEST_REPLAY_OUTBOUND = '0';
  const capture = installFetchCapture();
  app.use(
    '/api/test/captures',
    async (req, _res, next) => {
      try {
        // An independent owner completes a call before each capture observation.
        if (req.method === 'GET') await nativeFetch(`${baseUrl}/unrelated`);
        next();
      } catch (error) {
        next(error);
      }
    },
    capture
  );
  app.post('/api/auth/anonymous', (_req, res) => {
    res.json({ session: { access_token: 'offline-session' }, user: { id: 'offline-user' } });
  });
  app.get('/unrelated', (_req, res, next) => {
    reqWithToken('other-owner', async () => {
      await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST' });
      upstreamTokens.push('other-owner');
      res.json({ ok: true });
    }).catch(next);
  });
  app.post('/api/agents', async (req, res, next) => {
    try {
      invalidPosts += 1;
      assert.deepEqual(req.body, {});
      assert.ok(req.headers['x-capture-token']);
      if (emitMatchingCall) {
        await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST' });
      }
      res.status(400).json({ error: 'Goal is required' });
    } catch (error) {
      next(error);
    }
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.TEST_BASE_URL = baseUrl;
  const { testBoundary_validationShortCircuitNoOutbound: testCase } =
    await import('../blackbox/agents-boundary.cases');
  const { prisma } = await import('../blackbox/agents-blackbox-harness');
  function reqWithToken(token: string, action: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      captureTokenMiddleware(
        { headers: { 'x-capture-token': token } } as express.Request,
        {} as express.Response,
        () => {
          void action().then(resolve, reject);
        }
      );
    });
  }
  try {
    // Independent owner traffic must not prevent the actual invalid request.
    await testCase();
    assert.equal(invalidPosts, 1);
    assert.ok(upstreamTokens.length > 0);
    // The same case must still reject traffic emitted by its own request.
    emitMatchingCall = true;
    await assert.rejects(testCase, /Validation failure should make 0 outbound calls, got 1/);
    assert.equal(invalidPosts, 2);
    process.stdout.write(
      'PASS registered validation case isolates other owners and rejects own outbound\n'
    );
  } finally {
    globalThis.fetch = nativeFetch;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    await prisma.$disconnect();
  }
}

void run().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
