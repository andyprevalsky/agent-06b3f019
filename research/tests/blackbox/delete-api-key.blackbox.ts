/**
 * Blackbox tests for the delete-api-key Supabase edge function.
 *
 * Domain surface:
 *   POST /delete-api-key  -- deletes a RoseApiKey row belonging to the authenticated user
 *
 * Entrypoints tested:
 *   1. CORS preflight (OPTIONS)
 *   2. Auth boundary (missing/invalid/bad token)
 *   3. Validation (missing keyId)
 *   4. Happy path (seed key via DB, delete via function, verify gone)
 *   5. Tenant isolation (user cannot delete another user's key)
 *   6. Idempotency (deleting already-deleted key returns 200)
 *   7. Read-after-write (deleted key no longer appears in api-keys listing)
 *   8. Error surface consistency (all errors have { error: string })
 *   9. Same-input reproducibility
 *
 * Boundary:
 *   The edge function calls Supabase SDK internally (auth.getUser + from('RoseApiKey').delete).
 *   This is a Supabase-internal boundary, not a third-party HTTP call capturable by fetchCapture.
 *   We test it indirectly through observable HTTP responses and DB state changes visible via
 *   the api-keys listing endpoint.
 */

import {
  assertEquals,
  assertExists,
  assertStringIncludes,
} from 'https://deno.land/std@0.190.0/testing/asserts.ts';
import { cleanupTestData, getTestJwt, getTestUserId, seedApiKey, testClient } from './helpers.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** List the authenticated user's API keys via the api-keys edge function. */
async function listKeys(jwt: string): Promise<Array<{ id: string; name: string }>> {
  const res = await testClient.get('/api-keys', {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  assertEquals(res.status, 200, `Failed to list keys: ${JSON.stringify(res.data)}`);
  return res.data.keys || [];
}

// ---------------------------------------------------------------------------
// Auth boundary
// ---------------------------------------------------------------------------

Deno.test('DELETE /delete-api-key -- returns 401 when no Authorization header is sent', async () => {
  const res = await testClient.post('/delete-api-key', { keyId: 'does-not-matter' });
  assertEquals(res.status, 401);
  assertExists(res.data.error);
  assertStringIncludes(res.data.error.toLowerCase(), 'authorization');
});

Deno.test('DELETE /delete-api-key -- returns 401 when Authorization header has no Bearer prefix', async () => {
  const res = await testClient.post('/delete-api-key', { keyId: 'irrelevant' }, {
    headers: { Authorization: 'Basic dXNlcjpwYXNz' },
  });
  assertEquals(res.status, 401);
  assertExists(res.data.error);
});

Deno.test('DELETE /delete-api-key -- returns 401 when Bearer token is invalid', async () => {
  const res = await testClient.post('/delete-api-key', { keyId: 'irrelevant' }, {
    headers: { Authorization: 'Bearer invalid-token-value' },
  });
  assertEquals(res.status, 401);
  assertExists(res.data.error);
});

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

Deno.test('OPTIONS /delete-api-key -- returns CORS headers', async () => {
  const res = await testClient.request('/delete-api-key', { method: 'OPTIONS' });
  assertEquals(res.status, 200);
  const allowOrigin = res.headers.get('access-control-allow-origin');
  assertEquals(allowOrigin, '*');
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

Deno.test('DELETE /delete-api-key -- returns 400 when keyId is missing', async () => {
  const jwt = await getTestJwt();
  const res = await testClient.post('/delete-api-key', {}, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  assertEquals(res.status, 400);
  assertExists(res.data.error);
  assertStringIncludes(res.data.error.toLowerCase(), 'keyid');
});

Deno.test('DELETE /delete-api-key -- returns 400 when keyId is null', async () => {
  const jwt = await getTestJwt();
  const res = await testClient.post('/delete-api-key', { keyId: null }, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  assertEquals(res.status, 400);
  assertExists(res.data.error);
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

Deno.test('DELETE /delete-api-key -- deletes an existing key and returns success', async () => {
  const jwt = await getTestJwt();
  const userId = getTestUserId();
  const { id: keyId } = await seedApiKey(userId, 'bbx-delete-happy');

  const res = await testClient.post('/delete-api-key', { keyId }, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  assertEquals(res.status, 200);
  assertEquals(res.data.success, true);
  assertExists(res.data.message);
});

Deno.test('DELETE /delete-api-key -- response shape matches contract { success: boolean, message: string }', async () => {
  const jwt = await getTestJwt();
  const userId = getTestUserId();
  const { id: keyId } = await seedApiKey(userId, 'bbx-delete-shape');

  const res = await testClient.post('/delete-api-key', { keyId }, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  assertEquals(res.status, 200);
  assertEquals(typeof res.data.success, 'boolean');
  assertEquals(typeof res.data.message, 'string');
  assertEquals(res.data.success, true);
});

// ---------------------------------------------------------------------------
// Read-after-write (deletion)
// ---------------------------------------------------------------------------

Deno.test('DELETE /delete-api-key -- deleted key no longer appears in listing', async () => {
  const jwt = await getTestJwt();
  const userId = getTestUserId();
  const { id: keyId } = await seedApiKey(userId, 'bbx-delete-raw');

  // Verify key exists in listing
  const beforeKeys = await listKeys(jwt);
  const foundBefore = beforeKeys.some((k) => k.id === keyId);
  assertEquals(foundBefore, true, 'Newly seeded key should appear in listing');

  // Delete via edge function
  const delRes = await testClient.post('/delete-api-key', { keyId }, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  assertEquals(delRes.status, 200);

  // Verify gone
  const afterKeys = await listKeys(jwt);
  const foundAfter = afterKeys.some((k) => k.id === keyId);
  assertEquals(foundAfter, false, 'Deleted key must not appear in listing');
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

Deno.test('DELETE /delete-api-key -- deleting an already-deleted key returns 200 (idempotent)', async () => {
  const jwt = await getTestJwt();
  const userId = getTestUserId();
  const { id: keyId } = await seedApiKey(userId, 'bbx-delete-idemp');

  // Delete once
  const first = await testClient.post('/delete-api-key', { keyId }, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  assertEquals(first.status, 200);

  // Delete again -- Supabase .delete().eq() on zero rows is not an error
  const second = await testClient.post('/delete-api-key', { keyId }, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  assertEquals(second.status, 200);
  assertEquals(second.data.success, true);
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

Deno.test("DELETE /delete-api-key -- cannot delete another user's key", async () => {
  const jwt = await getTestJwt();

  // Seed a key for a *different* userId
  const otherUserId = crypto.randomUUID();
  const { id: keyId } = await seedApiKey(otherUserId, 'bbx-delete-tenant');

  // Try to delete it as the test user
  const res = await testClient.post('/delete-api-key', { keyId }, {
    headers: { Authorization: `Bearer ${jwt}` },
  });

  // The function does .delete().eq('userId', user.id) -- zero rows match,
  // Supabase treats this as success (not an error), but the key is NOT deleted.
  assertEquals(res.status, 200);
  assertEquals(res.data.success, true);

  // Verify the key still exists by querying directly via REST API
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || 'https://kzlurqihzaolhzsbkctf.supabase.co';
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const checkRes = await fetch(`${SUPABASE_URL}/rest/v1/RoseApiKey?id=eq.${keyId}`, {
    headers: {
      Authorization: `Bearer ${SERVICE_KEY}`,
      apikey: SERVICE_KEY,
    },
  });
  const rows = await checkRes.json();
  assertEquals(rows.length, 1, 'Key owned by another user must NOT be deleted');

  // Clean up the other user's key
  await fetch(`${SUPABASE_URL}/rest/v1/RoseApiKey?id=eq.${keyId}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${SERVICE_KEY}`,
      apikey: SERVICE_KEY,
    },
  });
});

Deno.test('DELETE /delete-api-key -- non-existent keyId returns 200 (no-op)', async () => {
  const jwt = await getTestJwt();
  const fakeKeyId = crypto.randomUUID();

  const res = await testClient.post('/delete-api-key', { keyId: fakeKeyId }, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  assertEquals(res.status, 200);
  assertEquals(res.data.success, true);
});

// ---------------------------------------------------------------------------
// Error surface consistency
// ---------------------------------------------------------------------------

Deno.test('DELETE /delete-api-key -- all error responses contain { error: string }', async () => {
  // 401 - no auth
  const noAuth = await testClient.post('/delete-api-key', { keyId: 'x' });
  assertEquals(noAuth.status, 401);
  assertEquals(typeof noAuth.data.error, 'string');

  // 401 - bad token
  const badToken = await testClient.post('/delete-api-key', { keyId: 'x' }, {
    headers: { Authorization: 'Bearer bad-token' },
  });
  assertEquals(badToken.status, 401);
  assertEquals(typeof badToken.data.error, 'string');

  // 400 - missing keyId
  const jwt = await getTestJwt();
  const noKey = await testClient.post('/delete-api-key', {}, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  assertEquals(noKey.status, 400);
  assertEquals(typeof noKey.data.error, 'string');
});

// ---------------------------------------------------------------------------
// Same-input reproducibility
// ---------------------------------------------------------------------------

Deno.test('DELETE /delete-api-key -- same invalid inputs produce same error responses', async () => {
  const res1 = await testClient.post('/delete-api-key', { keyId: 'test' });
  const res2 = await testClient.post('/delete-api-key', { keyId: 'test' });
  assertEquals(res1.status, res2.status);
  assertEquals(res1.data.error, res2.data.error);
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

Deno.test({
  name: 'cleanup -- delete test users and API keys created during this run',
  fn: async () => {
    await cleanupTestData();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
