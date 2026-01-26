#!/usr/bin/env tsx
/**
 * Auth Middleware Test
 *
 * Tests the new auth middleware with HS256 JWT verification.
 *
 * Usage:
 *   npx tsx src/tests/auth-middleware-test.ts
 */

import { config } from 'dotenv';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  details?: any;
}

const results: TestResult[] = [];

function log(message: string, data?: any) {
  console.log(`[Test] ${message}`, data ? JSON.stringify(data, null, 2) : '');
}

async function runTest(name: string, testFn: () => Promise<void>): Promise<TestResult> {
  try {
    await testFn();
    return { name, passed: true };
  } catch (error) {
    return {
      name,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Test 1: Create anonymous session via backend
 */
async function testCreateAnonymousSession() {
  log('Creating anonymous session...');

  const response = await fetch(`${BASE_URL}/api/auth/anonymous`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Failed to create anonymous session: ${response.status} - ${JSON.stringify(data)}`);
  }

  if (!data.user?.id) {
    throw new Error('Anonymous session missing user.id');
  }

  if (!data.session?.access_token) {
    throw new Error('Anonymous session missing access_token');
  }

  if (data.user.is_anonymous !== true) {
    throw new Error(`Expected is_anonymous=true, got ${data.user.is_anonymous}`);
  }

  log('Anonymous session created:', {
    userId: data.user.id,
    is_anonymous: data.user.is_anonymous,
    tokenLength: data.session.access_token.length,
    expires_at: data.session.expires_at,
  });

  return data;
}

/**
 * Test 2: Use anonymous token to access protected endpoint
 */
async function testAnonymousTokenAccess(accessToken: string) {
  log('Testing anonymous token access to /api/agents...');

  const response = await fetch(`${BASE_URL}/api/agents`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
    },
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Failed to access /api/agents with anonymous token: ${response.status} - ${JSON.stringify(data)}`);
  }

  if (!Array.isArray(data.agents)) {
    throw new Error('Expected agents array in response');
  }

  log('Successfully accessed /api/agents with anonymous token:', {
    agentCount: data.agents.length,
  });
}

/**
 * Test 3: Test with user-provided token
 */
async function testUserProvidedToken() {
  // Token from user's rose-session
  const userToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoxNzc3MjQzMDg5LCJpYXQiOjE3Njk0NjcwODksImlzcyI6Imh0dHBzOi8va3psdXJxaWh6YW9saHpzYmtjdGYuc3VwYWJhc2UuY28vYXV0aC92MSIsInN1YiI6ImI0Yzk2YTA5LTdkMjgtNDMwYi1iZjFhLTAxMTdlZjM4MGJiZCIsImVtYWlsIjoiIiwicGhvbmUiOiIiLCJhcHBfbWV0YWRhdGEiOnsicHJvdmlkZXIiOiJhbm9ueW1vdXMiLCJwcm92aWRlcnMiOlsiYW5vbnltb3VzIl19LCJ1c2VyX21ldGFkYXRhIjp7fSwicm9sZSI6ImF1dGhlbnRpY2F0ZWQiLCJhYWwiOiJhYWwxIiwiYW1yIjpbeyJtZXRob2QiOiJhbm9ueW1vdXMiLCJ0aW1lc3RhbXAiOjE3Njk0NjcwODl9XSwic2Vzc2lvbl9pZCI6ImJjYjczYTUyLWQzN2UtNDMwNC04MjJkLWM1NzAyZGFiNzMxOSIsImlzX2Fub255bW91cyI6dHJ1ZX0.iUw0Pa3sZnbZjXMpnk5vpVrYf55H3hoZShUN8mS4nLE';

  log('Testing user-provided token from rose-session...');

  // Decode JWT to show payload (without verification)
  const [, payloadBase64] = userToken.split('.');
  const payload = JSON.parse(Buffer.from(payloadBase64, 'base64').toString());
  log('Token payload:', {
    sub: payload.sub,
    iss: payload.iss,
    exp: payload.exp,
    is_anonymous: payload.is_anonymous,
    exp_date: new Date(payload.exp * 1000).toISOString(),
  });

  const response = await fetch(`${BASE_URL}/api/agents`, {
    headers: {
      'Authorization': `Bearer ${userToken}`,
    },
  });

  const data = await response.json();

  if (!response.ok) {
    log('Response status:', response.status);
    log('Response data:', data);
    throw new Error(`Failed to access /api/agents with user token: ${response.status} - ${JSON.stringify(data)}`);
  }

  log('Successfully accessed /api/agents with user-provided token:', {
    agentCount: data.agents?.length,
  });
}

/**
 * Test 4: Verify token structure matches middleware expectations
 */
async function testTokenStructure() {
  log('Creating new anonymous session to verify token structure...');

  const response = await fetch(`${BASE_URL}/api/auth/anonymous`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Failed to create session: ${JSON.stringify(data)}`);
  }

  const token = data.session.access_token;
  const [, payloadBase64] = token.split('.');
  const payload = JSON.parse(Buffer.from(payloadBase64, 'base64').toString());

  log('New token payload:', payload);

  // Verify required fields for auth middleware
  const requiredFields = ['sub', 'iss', 'exp', 'aud'];
  for (const field of requiredFields) {
    if (!payload[field]) {
      throw new Error(`Token missing required field: ${field}`);
    }
  }

  // Verify issuer format
  const expectedIssuerPattern = /https:\/\/.*\.supabase\.co\/auth\/v1/;
  if (!expectedIssuerPattern.test(payload.iss)) {
    throw new Error(`Invalid issuer format: ${payload.iss}`);
  }

  log('Token structure is valid');
}

/**
 * Main test runner
 */
async function main() {
  console.log('🧪 Auth Middleware Test Suite');
  console.log(`📡 Testing against: ${BASE_URL}\n`);

  // Test 1: Create anonymous session
  let result = await runTest('Create Anonymous Session', testCreateAnonymousSession);
  results.push(result);
  console.log(result.passed ? '✅' : '❌', result.name, result.error || '');

  // If we got a token, test with it
  if (result.passed) {
    // Get fresh session for testing
    const sessionResponse = await fetch(`${BASE_URL}/api/auth/anonymous`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const sessionData = await sessionResponse.json();
    const accessToken = sessionData.session?.access_token;

    if (accessToken) {
      // Test 2: Use anonymous token
      result = await runTest('Anonymous Token Access', () => testAnonymousTokenAccess(accessToken));
      results.push(result);
      console.log(result.passed ? '✅' : '❌', result.name, result.error || '');
    }
  }

  // Test 3: User-provided token
  result = await runTest('User-Provided Token Access', testUserProvidedToken);
  results.push(result);
  console.log(result.passed ? '✅' : '❌', result.name, result.error || '');

  // Test 4: Token structure
  result = await runTest('Token Structure Validation', testTokenStructure);
  results.push(result);
  console.log(result.passed ? '✅' : '❌', result.name, result.error || '');

  // Summary
  console.log('\n' + '='.repeat(50));
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`📊 Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.log('\n❌ FAILED TESTS:');
    results.filter(r => !r.passed).forEach(r => {
      console.log(`   • ${r.name}: ${r.error}`);
    });
    process.exit(1);
  }

  console.log('\n✅ ALL TESTS PASSED!');
  process.exit(0);
}

main().catch(error => {
  console.error('💥 Test suite crashed:', error);
  process.exit(1);
});
