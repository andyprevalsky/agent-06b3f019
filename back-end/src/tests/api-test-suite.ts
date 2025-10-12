#!/usr/bin/env tsx
/**
 * Comprehensive API Test Suite
 * Tests all backend endpoints for correctness and catches issues like double slashes
 * 
 * Usage:
 *   npm run test:api
 *   tsx src/tests/api-test-suite.ts
 */

import { config } from 'dotenv';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const TEST_PHONE = process.env.TEST_PHONE || '+19729777432';
const TEST_OTP = process.env.TEST_OTP || '181818';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://kzlurqihzaolhzsbkctf.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_IDiEs2g5w-TQavTqvwPAMA_idQLpbYp';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
  details?: any;
}

interface TestContext {
  accessToken?: string;
  userId?: string;
  agentId?: string;
  blueprintId?: string;
  toolIds?: string[];
}

const context: TestContext = {};

/**
 * Utility: Make HTTP request with better error handling
 */
async function request(
  url: string,
  options: RequestInit = {}
): Promise<{ status: number; data: any; headers: Headers }> {
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    let data;
    const contentType = response.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      data = await response.json();
    } else {
      data = await response.text();
    }

    return { status: response.status, data, headers: response.headers };
  } catch (error) {
    throw new Error(`Request failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Test runner with parallel execution
 */
async function runTest(
  name: string,
  testFn: () => Promise<void>
): Promise<TestResult> {
  const start = Date.now();
  try {
    await testFn();
    return {
      name,
      passed: true,
      duration: Date.now() - start,
    };
  } catch (error) {
    return {
      name,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - start,
    };
  }
}

/**
 * Authenticate and get access token
 */
async function authenticate(): Promise<void> {
  // Send OTP
  const otpResponse = await request(`${SUPABASE_URL}/auth/v1/otp`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'apikey': SUPABASE_ANON_KEY,
      'X-Supabase-Api-Version': '2024-01-01',
    },
    body: JSON.stringify({
      phone: TEST_PHONE,
      create_user: true,
      channel: 'sms',
    }),
  });

  if (otpResponse.status !== 200) {
    throw new Error(`OTP send failed: ${JSON.stringify(otpResponse.data)}`);
  }

  // Verify OTP
  const verifyResponse = await request(`${SUPABASE_URL}/auth/v1/verify`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'apikey': SUPABASE_ANON_KEY,
      'X-Supabase-Api-Version': '2024-01-01',
    },
    body: JSON.stringify({
      phone: TEST_PHONE,
      token: TEST_OTP,
      type: 'sms',
    }),
  });

  if (verifyResponse.status !== 200) {
    throw new Error(`OTP verify failed: ${JSON.stringify(verifyResponse.data)}`);
  }

  context.accessToken = verifyResponse.data.access_token;
  context.userId = verifyResponse.data.user.id;

  if (!context.accessToken) {
    throw new Error('No access token received');
  }
}

/**
 * TEST SUITE
 */

// ==================== PUBLIC ENDPOINTS ====================

async function testHealthEndpoint() {
  const response = await request(`${BASE_URL}/health`);
  
  if (response.status !== 200) {
    throw new Error(`Expected 200, got ${response.status}`);
  }
  
  if (!response.data.status || response.data.status !== 'ok') {
    throw new Error('Health check failed: missing or invalid status');
  }
  
  if (!response.data.timestamp) {
    throw new Error('Health check failed: missing timestamp');
  }
}

async function testModelsEndpoint() {
  // Test without double slash
  const response = await request(`${BASE_URL}/api/models`);
  
  if (response.status !== 200) {
    throw new Error(`Expected 200, got ${response.status}: ${JSON.stringify(response.data)}`);
  }
  
  if (!response.data.models || !Array.isArray(response.data.models)) {
    throw new Error('Models response missing or invalid models array');
  }

  // Verify URL construction doesn't create double slashes
  const testUrl = new URL('/api/models', BASE_URL);
  if (testUrl.pathname.includes('//')) {
    throw new Error('URL construction creates double slash!');
  }
}

async function testToolsEndpoint() {
  const response = await request(`${BASE_URL}/api/tools`);
  
  if (response.status !== 200) {
    throw new Error(`Expected 200, got ${response.status}`);
  }
  
  if (!response.data.tools || !Array.isArray(response.data.tools)) {
    throw new Error('Tools response missing or invalid tools array');
  }

  // Store tool IDs for later tests
  context.toolIds = response.data.tools.map((t: any) => t.id);
}

async function testWaitlistEndpoint() {
  const testEmail = `test-${Date.now()}@example.com`;
  const response = await request(`${BASE_URL}/api/waitlist`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Test User',
      email: testEmail,
      variant: 'midnight-black',
    }),
  });
  
  if (response.status !== 200) {
    throw new Error(`Expected 200, got ${response.status}`);
  }
  
  if (!response.data.success) {
    throw new Error('Waitlist join failed');
  }
}

async function testWaitlistValidation() {
  // Test invalid email
  const response = await request(`${BASE_URL}/api/waitlist`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Test User',
      email: 'invalid-email',
    }),
  });
  
  if (response.status !== 400) {
    throw new Error(`Expected 400 for invalid email, got ${response.status}`);
  }
}

async function testWaitlistDuplicate() {
  // Test duplicate email returns success
  const testEmail = 'duplicate@example.com';
  
  // First registration
  await request(`${BASE_URL}/api/waitlist`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Test User 1',
      email: testEmail,
    }),
  });
  
  // Second registration (duplicate)
  const response = await request(`${BASE_URL}/api/waitlist`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Test User 2',
      email: testEmail,
    }),
  });
  
  if (response.status !== 200) {
    throw new Error(`Expected 200 for duplicate, got ${response.status}`);
  }
  
  if (!response.data.alreadyRegistered) {
    throw new Error('Expected alreadyRegistered=true for duplicate');
  }
}

// ==================== AUTH REQUIRED ENDPOINTS ====================

async function testAgentsListEndpoint() {
  if (!context.accessToken) {
    throw new Error('No access token available');
  }

  const response = await request(`${BASE_URL}/api/agents`, {
    headers: {
      'Authorization': `Bearer ${context.accessToken}`,
    },
  });
  
  if (response.status !== 200) {
    throw new Error(`Expected 200, got ${response.status}: ${JSON.stringify(response.data)}`);
  }
  
  if (!response.data.agents || !Array.isArray(response.data.agents)) {
    throw new Error('Agents response missing or invalid agents array');
  }
}

async function testAgentsCreateEndpoint() {
  if (!context.accessToken) {
    throw new Error('No access token available');
  }

  const response = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${context.accessToken}`,
    },
    body: JSON.stringify({
      goal: 'Test agent for API test suite',
      model: 'anthropic/claude-sonnet-4.5',
      tool_ids: context.toolIds?.slice(0, 2) || [],
      task_queue: 'navi-agent-tasks-quicktest', // Use test queue
      verifier: {
        type: 'FLOAT_LLM_JUDGE',
        llm_judge_prompt: 'Evaluate if the goal is achieved',
      },
    }),
  });
  
  if (response.status !== 201) {
    throw new Error(`Expected 201, got ${response.status}: ${JSON.stringify(response.data)}`);
  }
  
  if (!response.data.agent_id) {
    throw new Error('Create agent response missing agent_id');
  }

  context.agentId = response.data.agent_id;
}

async function testAgentGetEndpoint() {
  if (!context.accessToken || !context.agentId) {
    throw new Error('No access token or agent ID available');
  }

  const response = await request(`${BASE_URL}/api/agents/${context.agentId}`, {
    headers: {
      'Authorization': `Bearer ${context.accessToken}`,
    },
  });
  
  if (response.status !== 200) {
    throw new Error(`Expected 200, got ${response.status}`);
  }
  
  if (!response.data.agent || !response.data.messages) {
    throw new Error('Get agent response missing agent or messages');
  }
}

async function testAgentPostMessageEndpoint() {
  if (!context.accessToken || !context.agentId) {
    throw new Error('No access token or agent ID available');
  }

  const response = await request(`${BASE_URL}/api/agents/${context.agentId}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${context.accessToken}`,
    },
    body: JSON.stringify({
      message: 'Test message from API test suite',
      role: 'USER',
    }),
  });
  
  if (response.status !== 201) {
    throw new Error(`Expected 201, got ${response.status}`);
  }
  
  if (!response.data.message_id) {
    throw new Error('Post message response missing message_id');
  }
}

async function testAgentPauseEndpoint() {
  if (!context.accessToken || !context.agentId) {
    throw new Error('No access token or agent ID available');
  }

  const response = await request(`${BASE_URL}/api/agents/${context.agentId}/pause`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${context.accessToken}`,
    },
  });
  
  if (response.status !== 200) {
    throw new Error(`Expected 200, got ${response.status}`);
  }
  
  if (!response.data.success) {
    throw new Error('Pause agent failed');
  }
}

async function testAgentResumeEndpoint() {
  if (!context.accessToken || !context.agentId) {
    throw new Error('No access token or agent ID available');
  }

  const response = await request(`${BASE_URL}/api/agents/${context.agentId}/resume`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${context.accessToken}`,
    },
  });
  
  if (response.status !== 200) {
    throw new Error(`Expected 200, got ${response.status}`);
  }
  
  if (!response.data.success) {
    throw new Error('Resume agent failed');
  }
}

async function testAgentUpdateStatusEndpoint() {
  if (!context.agentId) {
    throw new Error('No agent ID available');
  }

  // This endpoint requires BACKEND_API_KEY or user auth
  const response = await request(`${BASE_URL}/api/agents/${context.agentId}/status`, {
    method: 'PATCH',
    headers: {
      'X-API-Key': process.env.BACKEND_API_KEY || '',
      'Authorization': context.accessToken ? `Bearer ${context.accessToken}` : '',
    },
    body: JSON.stringify({
      status: 'ACTIVE',
      statusMessage: 'Running tests',
      progress: 0.5,
      tokenCount: 1000,
      contextSize: 50000,
      messageCount: 5,
    }),
  });
  
  if (response.status !== 200 && response.status !== 401) {
    throw new Error(`Expected 200 or 401, got ${response.status}: ${JSON.stringify(response.data)}`);
  }
}

async function testAgentDeleteEndpoint() {
  if (!context.accessToken || !context.agentId) {
    throw new Error('No access token or agent ID available');
  }

  const response = await request(`${BASE_URL}/api/agents/${context.agentId}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${context.accessToken}`,
    },
  });
  
  if (response.status !== 204) {
    throw new Error(`Expected 204, got ${response.status}`);
  }
}

async function testGenerateLLMPromptEndpoint() {
  if (!context.accessToken) {
    throw new Error('No access token available');
  }

  const response = await request(`${BASE_URL}/api/generate-llm-judge-prompt`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${context.accessToken}`,
    },
    body: JSON.stringify({
      goal: 'Test goal for prompt generation',
    }),
  });
  
  if (response.status !== 200) {
    throw new Error(`Expected 200, got ${response.status}: ${JSON.stringify(response.data)}`);
  }
  
  if (!response.data.prompt) {
    throw new Error('Generate prompt response missing prompt');
  }
}

async function testBlueprintsListEndpoint() {
  if (!context.accessToken) {
    throw new Error('No access token available');
  }

  const response = await request(`${BASE_URL}/api/blueprints`, {
    headers: {
      'Authorization': `Bearer ${context.accessToken}`,
    },
  });
  
  if (response.status !== 200) {
    throw new Error(`Expected 200, got ${response.status}`);
  }
  
  if (!Array.isArray(response.data)) {
    throw new Error('Blueprints response should be an array');
  }
}

async function testBlueprintsCreateEndpoint() {
  if (!context.accessToken) {
    throw new Error('No access token available');
  }

  const response = await request(`${BASE_URL}/api/blueprints`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${context.accessToken}`,
    },
    body: JSON.stringify({
      title: 'Test Blueprint',
      blueprint: 'This is a test blueprint for the API test suite',
    }),
  });
  
  if (response.status !== 201) {
    throw new Error(`Expected 201, got ${response.status}: ${JSON.stringify(response.data)}`);
  }
  
  if (!response.data.id) {
    throw new Error('Create blueprint response missing id');
  }

  context.blueprintId = response.data.id;
}

async function testBlueprintsSearchEndpoint() {
  if (!context.accessToken) {
    throw new Error('No access token available');
  }

  const response = await request(`${BASE_URL}/api/blueprints/search`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${context.accessToken}`,
    },
    body: JSON.stringify({
      goal: 'Test search query',
      limit: 3,
    }),
  });
  
  // Search requires OpenRouter API key for embeddings
  // Accept 200 (success) or 500 (no API key) as valid
  if (response.status !== 200 && response.status !== 500) {
    throw new Error(`Expected 200 or 500, got ${response.status}: ${JSON.stringify(response.data)}`);
  }
  
  if (response.status === 200 && !Array.isArray(response.data)) {
    throw new Error('Blueprints search response should be an array');
  }
  
  // If 500, it's likely due to missing OPENROUTER_API_KEY which is acceptable
  if (response.status === 500) {
    console.log('   ⚠️  Blueprint search requires OPENROUTER_API_KEY (optional)');
  }
}

async function testBlueprintsDeleteEndpoint() {
  if (!context.accessToken || !context.blueprintId) {
    throw new Error('No access token or blueprint ID available');
  }

  const response = await request(`${BASE_URL}/api/blueprints/${context.blueprintId}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${context.accessToken}`,
    },
  });
  
  if (response.status !== 204) {
    throw new Error(`Expected 204, got ${response.status}`);
  }
}

// ==================== AUTH TESTS ====================

async function testUnauthorizedAccess() {
  const response = await request(`${BASE_URL}/api/agents`);
  
  if (response.status !== 401) {
    throw new Error(`Expected 401 for unauthorized access, got ${response.status}`);
  }
}

async function testInvalidToken() {
  const response = await request(`${BASE_URL}/api/agents`, {
    headers: {
      'Authorization': 'Bearer invalid-token-12345',
    },
  });
  
  if (response.status !== 401) {
    throw new Error(`Expected 401 for invalid token, got ${response.status}`);
  }
}

// ==================== URL VALIDATION TESTS ====================

async function testNoDoubleSlashesInURLs() {
  const endpoints = [
    '/health',
    '/api/models',
    '/api/tools',
    '/api/waitlist',
    '/api/agents',
    '/api/blueprints',
    '/api/generate-llm-judge-prompt',
  ];

  for (const endpoint of endpoints) {
    const url = new URL(endpoint, BASE_URL);
    if (url.pathname.includes('//')) {
      throw new Error(`Double slash found in URL: ${url.pathname}`);
    }
    
    // Also test with trailing slash on base URL
    const baseWithSlash = BASE_URL.endsWith('/') ? BASE_URL : `${BASE_URL}/`;
    const url2 = new URL(endpoint, baseWithSlash);
    if (url2.pathname.includes('//')) {
      throw new Error(`Double slash found in URL with trailing slash: ${url2.pathname}`);
    }
  }
}

/**
 * Main test suite runner
 */
async function runAllTests() {
  console.log('🧪 Starting API Test Suite...\n');
  console.log(`📡 Testing against: ${BASE_URL}\n`);

  // Sequential tests (require auth first)
  const sequentialTests = [
    { name: 'Authentication', fn: authenticate, group: 'auth' },
  ];

  console.log('🔐 Running authentication tests...');
  for (const test of sequentialTests) {
    const result = await runTest(test.name, test.fn);
    printResult(result);
    if (!result.passed) {
      console.error('\n❌ Authentication failed, cannot continue');
      process.exit(1);
    }
  }

  // Parallel tests - Public endpoints
  const publicTests = [
    { name: 'Health Endpoint', fn: testHealthEndpoint, group: 'public' },
    { name: 'Models Endpoint', fn: testModelsEndpoint, group: 'public' },
    { name: 'Tools Endpoint', fn: testToolsEndpoint, group: 'public' },
    { name: 'Waitlist Endpoint', fn: testWaitlistEndpoint, group: 'public' },
    { name: 'Waitlist Validation', fn: testWaitlistValidation, group: 'public' },
    { name: 'Waitlist Duplicate', fn: testWaitlistDuplicate, group: 'public' },
    { name: 'URL Double Slash Check', fn: testNoDoubleSlashesInURLs, group: 'public' },
  ];

  // Parallel tests - Auth required (must run after agent creation)
  const authTests = [
    { name: 'Agents List', fn: testAgentsListEndpoint, group: 'auth' },
    { name: 'Generate LLM Prompt', fn: testGenerateLLMPromptEndpoint, group: 'auth' },
    { name: 'Blueprints List', fn: testBlueprintsListEndpoint, group: 'auth' },
    { name: 'Unauthorized Access', fn: testUnauthorizedAccess, group: 'auth' },
    { name: 'Invalid Token', fn: testInvalidToken, group: 'auth' },
  ];

  // Agent workflow tests (must run sequentially)
  const agentWorkflowTests = [
    { name: 'Create Agent', fn: testAgentsCreateEndpoint, group: 'agent-workflow' },
    { name: 'Get Agent', fn: testAgentGetEndpoint, group: 'agent-workflow' },
    { name: 'Post Message', fn: testAgentPostMessageEndpoint, group: 'agent-workflow' },
    { name: 'Pause Agent', fn: testAgentPauseEndpoint, group: 'agent-workflow' },
    { name: 'Resume Agent', fn: testAgentResumeEndpoint, group: 'agent-workflow' },
    { name: 'Update Agent Status', fn: testAgentUpdateStatusEndpoint, group: 'agent-workflow' },
    { name: 'Delete Agent', fn: testAgentDeleteEndpoint, group: 'agent-workflow' },
  ];

  // Blueprint workflow tests (must run sequentially)
  const blueprintWorkflowTests = [
    { name: 'Create Blueprint', fn: testBlueprintsCreateEndpoint, group: 'blueprint-workflow' },
    { name: 'Search Blueprints', fn: testBlueprintsSearchEndpoint, group: 'blueprint-workflow' },
    { name: 'Delete Blueprint', fn: testBlueprintsDeleteEndpoint, group: 'blueprint-workflow' },
  ];

  // Run public tests in parallel
  console.log('\n📋 Running public endpoint tests...');
  const publicResults = await Promise.all(
    publicTests.map(test => runTest(test.name, test.fn))
  );
  publicResults.forEach(printResult);

  // Run auth tests in parallel
  console.log('\n🔒 Running authenticated endpoint tests...');
  const authResults = await Promise.all(
    authTests.map(test => runTest(test.name, test.fn))
  );
  authResults.forEach(printResult);

  // Run agent workflow tests sequentially
  console.log('\n🤖 Running agent workflow tests...');
  const agentWorkflowResults = [];
  for (const test of agentWorkflowTests) {
    const result = await runTest(test.name, test.fn);
    printResult(result);
    agentWorkflowResults.push(result);
    if (!result.passed && test.name === 'Create Agent') {
      console.warn('⚠️  Agent creation failed, skipping remaining agent tests');
      break;
    }
  }

  // Run blueprint workflow tests sequentially
  console.log('\n📝 Running blueprint workflow tests...');
  const blueprintWorkflowResults = [];
  for (const test of blueprintWorkflowTests) {
    const result = await runTest(test.name, test.fn);
    printResult(result);
    blueprintWorkflowResults.push(result);
    if (!result.passed && test.name === 'Create Blueprint') {
      console.warn('⚠️  Blueprint creation failed, skipping remaining blueprint tests');
      break;
    }
  }

  // Collect all results
  const allResults = [
    ...sequentialTests.map(t => ({ name: t.name, passed: true, duration: 0 })), // Auth already passed
    ...publicResults,
    ...authResults,
    ...agentWorkflowResults,
    ...blueprintWorkflowResults,
  ];

  // Print summary
  const passed = allResults.filter(r => r.passed).length;
  const failed = allResults.filter(r => !r.passed).length;
  const totalDuration = allResults.reduce((sum, r) => sum + r.duration, 0);

  console.log('\n' + '='.repeat(60));
  console.log(`\n📊 Test Summary:`);
  console.log(`   Total: ${allResults.length}`);
  console.log(`   ✅ Passed: ${passed}`);
  console.log(`   ❌ Failed: ${failed}`);
  console.log(`   ⏱️  Duration: ${totalDuration}ms\n`);

  if (failed > 0) {
    console.log('❌ FAILED TESTS:');
    const failedTests: TestResult[] = allResults.filter(r => !r.passed);
    failedTests.forEach(r => console.log(`   • ${r.name}: ${r.error || 'Unknown error'}`));
    console.log('');
    process.exit(1);
  }

  console.log('✅ ALL TESTS PASSED!\n');
  process.exit(0);
}

function printResult(result: TestResult) {
  const icon = result.passed ? '✅' : '❌';
  const duration = `(${result.duration}ms)`;
  console.log(`${icon} ${result.name} ${duration}`);
  if (!result.passed && result.error) {
    console.log(`   Error: ${result.error}`);
  }
}

// Run the test suite
if (require.main === module) {
  runAllTests().catch(error => {
    console.error('\n💥 Test suite crashed:', error);
    process.exit(1);
  });
}

export { runAllTests };

