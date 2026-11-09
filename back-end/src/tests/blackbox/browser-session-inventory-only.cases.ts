/** Actual prepare-auth HTTP route, Prisma ownership and complete inventory. */
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import type { Browser } from 'playwright';
import { registerBrowserCredentialRoutes } from '../../domains/browser-session/routes.credentials';
import { prepareSessionCredentials } from '../../domains/browser-session/service';
import { prisma } from '../../providers/database';

export async function verifyInventoryOnly(input: {
  sessionId: string;
  userId: string;
  otherUserId: string;
  passwordId: string;
  passkeyId: string;
  browser: Browser;
  injectionCount: () => number;
}) {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerBrowserCredentialRoutes(router);
  app.use('/api/browser-session', router);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}/api/browser-session/${input.sessionId}/prepare-auth`;
  const request = (userId: string, body: unknown) =>
    fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': process.env.BACKEND_API_KEY!,
        'X-User-Id': userId,
      },
      body: JSON.stringify(body),
    });
  try {
    await prisma.browserSession.update({
      where: { sessionId: input.sessionId },
      data: { provider: 'tilion' },
    });
    const response = await request(input.userId, {
      target_url: 'https://www.example.co.uk/login',
      restore_browser_state: false,
    });
    assert.equal(response.status, 200);
    const inventory = await response.json();
    assert.equal(
      Object.hasOwn(inventory, 'worker_apply'),
      false,
      'Inventory-only HTTP route must not replace the live browser state'
    );
    assert.equal(inventory.auth_credential_ref, null);
    assert.equal(inventory.auth_source, 'none');
    assert.equal(inventory.cookies_count, 0);
    assert.equal(inventory.cookies_injected, false);
    assert.deepEqual(inventory.browser_state_injection, {
      cookies: { injected: false, cookieCount: 0, authSource: 'none', credentialRef: null },
      fingerprint: { injected: false },
      indexedDB: { injected: false, originCount: 0 },
      localStorage: { injected: false, originCount: 0 },
      permissions: { injected: false, grantCount: 0 },
      cacheStorage: { injected: false, originCount: 0 },
    });
    assert.ok(inventory.passwords.some((p: { id: string }) => p.id === input.passwordId));
    assert.ok(inventory.passkeys.some((p: { id: string }) => p.id === input.passkeyId));
    assert.ok(
      inventory.auth_options.passwords.some((p: { id: string }) => p.id === input.passwordId)
    );
    assert.ok(
      inventory.auth_options.passkeys.some((p: { id: string }) => p.id === input.passkeyId)
    );
    assert.equal(
      (
        await request(input.otherUserId, {
          target_url: 'https://www.example.co.uk',
          restore_browser_state: false,
        })
      ).status,
      404
    );
    assert.equal(
      (
        await request(input.userId, {
          target_url: 'https://www.example.co.uk',
          restore_browser_state: 'false',
        })
      ).status,
      400
    );
    const restored = await (
      await request(input.userId, { target_url: 'https://www.example.co.uk/login' })
    ).json();
    assert.ok(restored.worker_apply, 'Omitted option preserves Tilion explicit restoration');
    const explicit = await (
      await request(input.userId, {
        target_url: 'https://www.example.co.uk/login',
        restore_browser_state: true,
      })
    ).json();
    assert.ok(explicit.worker_apply, 'Explicit true preserves Tilion restoration');
    await prisma.browserSession.update({
      where: { sessionId: input.sessionId },
      data: { provider: 'kernel' },
    });
    const kernelRoute = await request(input.userId, {
      target_url: 'https://www.example.co.uk/login',
      restore_browser_state: false,
    });
    assert.equal(
      kernelRoute.status,
      200,
      'Inventory-only owned provider must not connect to remote browser'
    );
    const kernelInventory = await kernelRoute.json();
    assert.deepEqual(kernelInventory.passwords, inventory.passwords);
    // Every inventory reserves a fresh passkey counter window; contents stay complete.
    assert.deepEqual(
      kernelInventory.passkeys.map(
        ({ signCount: _counter, ...key }: { signCount: number; id: string }) => key
      ),
      inventory.passkeys.map(
        ({ signCount: _counter, ...key }: { signCount: number; id: string }) => key
      )
    );
    assert.ok(kernelInventory.passkeys[0].signCount > inventory.passkeys[0].signCount);
    assert.equal(kernelInventory.auth_source, 'none');
    assert.equal(Object.hasOwn(kernelInventory, 'worker_apply'), false);
    const count = input.injectionCount();
    const backendOwned = await prepareSessionCredentials(
      input.sessionId,
      input.userId,
      'https://www.example.co.uk/login',
      { browser: input.browser, restoreBrowserState: false }
    );
    assert.equal(
      input.injectionCount(),
      count,
      'Inventory-only backend provider must not inject state'
    );
    assert.equal(backendOwned.auth_credential_ref, null);
    assert.equal(backendOwned.passwords[0]?.id, input.passwordId);
    assert.equal(backendOwned.passkeys[0]?.id, input.passkeyId);
  } finally {
    await prisma.browserSession.update({
      where: { sessionId: input.sessionId },
      data: { provider: 'kernel' },
    });
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}
