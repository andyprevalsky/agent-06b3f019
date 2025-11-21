/**
 * Tests for POST /completions
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import { testClient } from "./utils/test-client.ts";
import { assertStatusCode, assertHasProperty, sampleMessages } from "./utils/fixtures.ts";

// Get API key from environment (generate via /rose/generate-api-key)
const ROSE_API_KEY = Deno.env.get('ROSE_API_KEY') || '';

Deno.test("POST /completions - returns chat completion with valid API key", async () => {
  const response = await testClient.post('/completions', {
    model: 'rose-labs/rose-1-fast',
    messages: sampleMessages,
  }, {
    headers: { 'x-api-key': ROSE_API_KEY },
  });
  
  if (response.status === 401) {
    console.log('⚠️  Test requires valid API key in ROSE_API_KEY env var (generate via /rose/generate-api-key)');
    return;
  }
  
  assertStatusCode(response.status, 200);
  assertHasProperty(response.data, 'id');
  assertHasProperty(response.data, 'object');
  assertHasProperty(response.data, 'choices');
  assertHasProperty(response.data, 'usage');
  
  assertEquals(response.data.object, 'chat.completion');
  assertExists(response.data.choices[0].message.content);
});

Deno.test("POST /completions - rejects request without API key", async () => {
  const response = await testClient.post('/completions', {
    model: 'rose-labs/rose-1-fast',
    messages: sampleMessages,
  });
  
  assertStatusCode(response.status, 401);
  assertHasProperty(response.data, 'error');
});

Deno.test("POST /completions - accepts seed parameter", async () => {
  const response = await testClient.post('/completions', {
    model: 'rose-labs/rose-1-fast',
    messages: sampleMessages,
    seed: 42,
  }, {
    headers: { 'x-api-key': ROSE_API_KEY },
  });
  
  if (response.status === 401) {
    console.log('⚠️  Test requires valid API key');
    return;
  }
  
  // Should not error with seed parameter
  assertEquals(response.status === 200 || response.status === 401, true);
});

Deno.test("POST /completions - accepts cot_steps parameter", async () => {
  const response = await testClient.post('/completions', {
    model: 'rose-labs/rose-1-fast',
    messages: sampleMessages,
    cot_steps: 3,
  }, {
    headers: { 'x-api-key': ROSE_API_KEY },
  });
  
  if (response.status === 401) {
    console.log('⚠️  Test requires valid API key');
    return;
  }
  
  // Should not error with cot_steps parameter
  assertEquals(response.status === 200 || response.status === 401, true);
});

Deno.test("POST /completions - accepts tools parameter", async () => {
  const response = await testClient.post('/completions', {
    model: 'rose-labs/rose-1-fast',
    messages: [{ role: 'user', content: 'What is the weather?' }],
    tools: [{
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get weather',
        parameters: {
          type: 'object',
          properties: {
            location: { type: 'string' },
          },
        },
      },
    }],
  }, {
    headers: { 'x-api-key': ROSE_API_KEY },
  });
  
  if (response.status === 401) {
    console.log('⚠️  Test requires valid API key');
    return;
  }
  
  // Should not error with tools parameter
  assertEquals(response.status === 200 || response.status === 401, true);
});

Deno.test("POST /completions - returns 400 for missing model", async () => {
  const response = await testClient.post('/completions', {
    messages: sampleMessages,
  }, {
    headers: { 'x-api-key': ROSE_API_KEY },
  });
  
  if (response.status === 401) {
    console.log('⚠️  Test requires valid API key');
    return;
  }
  
  assertStatusCode(response.status, 400);
  assertHasProperty(response.data, 'error');
});

Deno.test("POST /completions - returns 400 for missing messages", async () => {
  const response = await testClient.post('/completions', {
    model: 'rose-labs/rose-1-fast',
  }, {
    headers: { 'x-api-key': ROSE_API_KEY },
  });
  
  if (response.status === 401) {
    console.log('⚠️  Test requires valid API key');
    return;
  }
  
  assertStatusCode(response.status, 400);
  assertHasProperty(response.data, 'error');
});

Deno.test("POST /completions - returns 400 for invalid model", async () => {
  const response = await testClient.post('/completions', {
    model: 'invalid-model-name',
    messages: sampleMessages,
  }, {
    headers: { 'x-api-key': ROSE_API_KEY },
  });
  
  if (response.status === 401) {
    console.log('⚠️  Test requires valid API key');
    return;
  }
  
  assertStatusCode(response.status, 400);
  assertHasProperty(response.data, 'error');
});

