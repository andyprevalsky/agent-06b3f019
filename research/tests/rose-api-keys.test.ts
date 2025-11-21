/**
 * Tests for API Key Management
 * - POST /generate-api-key
 * - GET /api-keys
 * - DELETE /delete-api-key
 */

import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import { testClient } from "./utils/test-client.ts";
import { assertStatusCode, assertHasProperty, assertIsArray } from "./utils/fixtures.ts";

// Tests use production Supabase credentials
// Get JWT from your Supabase session (use real user login)
const SUPABASE_JWT = Deno.env.get('SUPABASE_JWT') || '';

Deno.test("POST /generate-api-key - creates new API key", async () => {
  const response = await testClient.post('/generate-api-key', {
    name: 'Test Key',
  }, {
    headers: { 'Authorization': `Bearer ${SUPABASE_JWT}` },
  });
  
  if (response.status === 401) {
    console.log('⚠️  Test requires valid Supabase JWT in SUPABASE_JWT env var');
    return;
  }
  
  assertStatusCode(response.status, 200);
  assertHasProperty(response.data, 'apiKey');
  assertHasProperty(response.data, 'id');
  assertHasProperty(response.data, 'createdAt');
  
  // Verify API key is 32 characters
  assertEquals(response.data.apiKey.length, 32);
});

Deno.test("POST /generate-api-key - rejects unauthenticated request", async () => {
  const response = await testClient.post('/generate-api-key', {
    name: 'Test Key',
  });
  
  assertStatusCode(response.status, 401);
  assertHasProperty(response.data, 'error');
});

Deno.test("GET /api-keys - lists user API keys", async () => {
  const response = await testClient.get('/api-keys', {
    headers: { 'Authorization': `Bearer ${SUPABASE_JWT}` },
  });
  
  if (response.status === 401) {
    console.log('⚠️  Test requires valid JWT');
    return;
  }
  
  assertStatusCode(response.status, 200);
  assertHasProperty(response.data, 'keys');
  assertIsArray(response.data.keys);
  
  if (response.data.keys.length > 0) {
    const key = response.data.keys[0];
    assertHasProperty(key, 'id');
    assertHasProperty(key, 'name');
    assertHasProperty(key, 'createdAt');
    assertHasProperty(key, 'maskedApiKey');
    
    // Verify key is masked
    assertEquals(key.maskedApiKey.startsWith('...'), true, 'API key should be masked');
    assertEquals(key.maskedApiKey.length, 7, 'Masked key should be ...XXXX format');
  }
});

Deno.test("GET /api-keys - rejects unauthenticated request", async () => {
  const response = await testClient.get('/api-keys');
  
  assertStatusCode(response.status, 401);
  assertHasProperty(response.data, 'error');
});

Deno.test("DELETE /delete-api-key - deletes API key", async () => {
  // First, create a key to delete
  const createResponse = await testClient.post('/generate-api-key', {
    name: 'Delete Test',
  }, {
    headers: { 'Authorization': `Bearer ${SUPABASE_JWT}` },
  });
  
  if (createResponse.status === 401) {
    console.log('⚠️  Test requires valid JWT');
    return;
  }
  
  const keyId = createResponse.data.id;
  
  // Now delete it
  const deleteResponse = await testClient.delete('/delete-api-key', {
    keyId,
  }, {
    headers: { 'Authorization': `Bearer ${SUPABASE_JWT}` },
  });
  
  assertStatusCode(deleteResponse.status, 200);
  assertHasProperty(deleteResponse.data, 'success');
  assertEquals(deleteResponse.data.success, true);
});

Deno.test("DELETE /delete-api-key - rejects unauthenticated request", async () => {
  const response = await testClient.delete('/delete-api-key', {
    keyId: 'fake-id',
  });
  
  assertStatusCode(response.status, 401);
  assertHasProperty(response.data, 'error');
});

Deno.test("DELETE /delete-api-key - returns 400 for missing keyId", async () => {
  const response = await testClient.delete('/delete-api-key', {}, {
    headers: { 'Authorization': `Bearer ${SUPABASE_JWT}` },
  });
  
  if (response.status === 401) {
    console.log('⚠️  Test requires valid JWT');
    return;
  }
  
  assertStatusCode(response.status, 400);
  assertHasProperty(response.data, 'error');
});

