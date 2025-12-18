/**
 * Tests for GET /cost
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import { testClient } from "./utils/test-client.ts";
import { assertStatusCode, assertHasProperty } from "./utils/fixtures.ts";

Deno.test("GET /cost - returns cost for rose-1-lite", async () => {
  const response = await testClient.get('/cost?model=rose-labs/rose-1-lite');
  
  assertStatusCode(response.status, 200);
  assertHasProperty(response.data, 'model');
  assertHasProperty(response.data, 'contextLength');
  assertHasProperty(response.data, 'pricing');
  assertHasProperty(response.data.pricing, 'costPerMillionInputTokens');
  assertHasProperty(response.data.pricing, 'costPerMillionOutputTokens');
  
  // Verify types
  assertEquals(typeof response.data.pricing.costPerMillionInputTokens, 'number');
  assertEquals(typeof response.data.pricing.costPerMillionOutputTokens, 'number');
  assertEquals(typeof response.data.contextLength, 'number');
});

Deno.test("GET /cost - returns cost for rose-1-ultra", async () => {
  const response = await testClient.get('/cost?model=rose-labs/rose-1-ultra');
  
  assertStatusCode(response.status, 200);
  assertEquals(response.data.model, 'rose-1-ultra');
});

Deno.test("GET /cost - normalizes model name (removes rose-labs/ prefix)", async () => {
  const response1 = await testClient.get('/cost?model=rose-labs/rose-1-lite');
  const response2 = await testClient.get('/cost?model=rose-1-lite');
  
  assertEquals(response1.data.model, response2.data.model);
});

Deno.test("GET /cost - returns 400 for missing model parameter", async () => {
  const response = await testClient.get('/cost');
  
  assertStatusCode(response.status, 400);
  assertHasProperty(response.data, 'error');
});

Deno.test("GET /cost - returns 404 for unknown model", async () => {
  const response = await testClient.get('/cost?model=unknown-model-xyz');
  
  assertStatusCode(response.status, 404);
  assertHasProperty(response.data, 'error');
});

Deno.test("GET /cost - does not return poolSize", async () => {
  const response = await testClient.get('/cost?model=rose-1-lite');
  
  assertStatusCode(response.status, 200);
  assertEquals('poolSize' in response.data, false, 'poolSize should not be in response');
});











