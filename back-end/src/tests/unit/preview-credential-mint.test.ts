import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { requireCredentialMintSession } from '../../providers/credentialMintAuth';

test('preview credential mint boundary denies both issuers before side effects and preserves normal sessions', async () => {
  const app = express();
  let mintCalls = 0;
  app.use((req, _res, next) => {
    Object.assign(req, { user: { authMethod: req.headers['x-test-auth-method'] } });
    next();
  });
  for (const route of ['/api/api-keys', '/api/user-ui/publish-token']) {
    app.post(route, requireCredentialMintSession, (_req, res) => {
      mintCalls++;
      res.status(201).json({ issued: true });
    });
  }
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    for (const path of ['/api/api-keys', '/api/user-ui/publish-token']) {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
        method: 'POST',
        headers: { 'x-test-auth-method': 'preview_handoff' },
      });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).code, 'USER_SESSION_REQUIRED');
    }
    assert.equal(mintCalls, 0, 'no issuer ran for preview sessions');
    for (const method of ['otp', 'password', 'oauth', undefined]) {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/api-keys`, {
        method: 'POST',
        headers: method ? { 'x-test-auth-method': method } : {},
      });
      assert.equal(response.status, 201, `existing auth method ${method} retains access`);
    }
    assert.equal(mintCalls, 4);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});
