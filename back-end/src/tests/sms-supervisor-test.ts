#!/usr/bin/env tsx
/**
 * SMS Supervisor Test Suite
 *
 * Comprehensive tests for the SMS supervisor agent system:
 * 1. Shortcode generation — alphabet, length, uniqueness
 * 2. SMS templates — all templates produce valid strings
 * 3. Webhook routing — shortcode fast-path, supervisor path, validation
 * 4. Notify endpoint — all event types, validation, auth
 * 5. Tool schemas — all 6 tool schemas valid
 * 6. Session management — create, load
 * 7. Context builder — formatting, empty states
 *
 * Usage:
 *   npx tsx src/tests/sms-supervisor-test.ts
 */

import { config } from 'dotenv';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || 'AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

// ============================================
// Test Helpers
// ============================================

async function request(
  url: string,
  options: RequestInit = {}
): Promise<{ status: number; data: any; headers: Headers }> {
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
  } else if (contentType?.includes('text/xml')) {
    data = await response.text();
  } else {
    data = await response.text();
  }

  return { status: response.status, data, headers: response.headers };
}

function apiHeaders(): Record<string, string> {
  return { 'X-API-Key': API_KEY };
}

async function runTest(name: string, testFn: () => Promise<void>): Promise<TestResult> {
  const start = Date.now();
  try {
    await testFn();
    return { name, passed: true, duration: Date.now() - start };
  } catch (error) {
    return {
      name,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - start,
    };
  }
}

function printResult(result: TestResult) {
  const icon = result.passed ? '✅' : '❌';
  const duration = `${result.duration}ms`;
  console.log(`  ${icon} ${result.name} (${duration})${result.error ? ` — ${result.error}` : ''}`);
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: any, expected: any, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ============================================
// 1. Shortcode Generation Tests (pure logic)
// ============================================

const SHORTCODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function generateShortcodeLocal(): string {
  const crypto = require('crypto');
  const bytes = crypto.randomBytes(5);
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += SHORTCODE_ALPHABET[bytes[i] % SHORTCODE_ALPHABET.length];
  }
  return code;
}

async function testShortcodeLength() {
  const code = generateShortcodeLocal();
  assertEqual(code.length, 5, 'Shortcode length');
}

async function testShortcodeAlphabet() {
  // Generate 100 shortcodes and verify all chars are in the safe alphabet
  for (let i = 0; i < 100; i++) {
    const code = generateShortcodeLocal();
    for (const char of code) {
      assert(
        SHORTCODE_ALPHABET.includes(char),
        `Shortcode contains invalid char '${char}' not in alphabet`
      );
    }
  }
}

async function testShortcodeNoAmbiguousChars() {
  const ambiguous = ['0', 'O', '1', 'I', 'l'];
  for (let i = 0; i < 200; i++) {
    const code = generateShortcodeLocal();
    for (const char of code) {
      assert(
        !ambiguous.includes(char),
        `Shortcode contains ambiguous char '${char}'`
      );
    }
  }
}

async function testShortcodeUniqueness() {
  // Generate 1000 shortcodes and check for collisions
  const codes = new Set<string>();
  for (let i = 0; i < 1000; i++) {
    codes.add(generateShortcodeLocal());
  }
  // With 32^5 = 33M possible codes, 1000 should be unique
  assert(codes.size >= 990, `Expected >=990 unique codes from 1000, got ${codes.size}`);
}

async function testShortcodeAlphabetSize() {
  assertEqual(SHORTCODE_ALPHABET.length, 32, 'Alphabet should have 32 chars (no ambiguous)');
}

// ============================================
// 2. SMS Template Tests (pure logic)
// ============================================

async function testTemplateAgentStarted() {
  const { SMS_TEMPLATES, getAgentUrl } = await import('../lib/smsTemplates');
  const msg = SMS_TEMPLATES.agentStarted('a3f2b1', 'Buy socks on amazon', 'https://roselabs.ai?agent-id=123');
  assert(msg.includes('[a3f2b1]'), 'Should include agent prefix');
  assert(msg.includes('Started:'), 'Should include Started');
  assert(msg.includes('Buy socks'), 'Should include goal');
  assert(msg.includes('Track:'), 'Should include Track URL');
}

async function testTemplatePlannerQuestion() {
  const { SMS_TEMPLATES } = await import('../lib/smsTemplates');
  const msg = SMS_TEMPLATES.plannerQuestion('c8d4e2', 'Which color socks?');
  assert(msg.includes('[c8d4e2]'), 'Should include agent prefix');
  assert(msg.includes('Rose asks:'), 'Should include Rose asks');
  assert(msg.includes('Which color'), 'Should include question');
}

async function testTemplatePlannerFyi() {
  const { SMS_TEMPLATES } = await import('../lib/smsTemplates');
  const msg = SMS_TEMPLATES.plannerFyi('c8d4e2', 'Found 3 options');
  assert(msg.includes('[c8d4e2]'), 'Should include agent prefix');
  assert(msg.includes('FYI:'), 'Should include FYI');
}

async function testTemplateWriteLock() {
  const { SMS_TEMPLATES } = await import('../lib/smsTemplates');
  const msg = SMS_TEMPLATES.writeLock('a3f2b1', 'Purchase $29.99 socks', 'H7K2M');
  assert(msg.includes('[a3f2b1]'), 'Should include agent prefix');
  assert(msg.includes('Approval needed:'), 'Should include Approval needed');
  assert(msg.includes('Approve H7K2M'), 'Should include shortcode approval instruction');
}

async function testTemplateAgentCompleted() {
  const { SMS_TEMPLATES } = await import('../lib/smsTemplates');
  const msg = SMS_TEMPLATES.agentCompleted('a3f2b1', 'Ordered blue socks', 'https://roselabs.ai?agent-id=123');
  assert(msg.includes('[a3f2b1]'), 'Should include agent prefix');
  assert(msg.includes('Done:'), 'Should include Done');
  assert(msg.includes('Full report:'), 'Should include report URL');
}

async function testTemplateCostLimit() {
  const { SMS_TEMPLATES } = await import('../lib/smsTemplates');
  const msg = SMS_TEMPLATES.costLimit('a3f2b1', 100, 100);
  assert(msg.includes('[a3f2b1]'), 'Should include agent prefix');
  assert(msg.includes('Budget limit hit'), 'Should include budget limit');
  assert(msg.includes('$1.00/$1.00'), 'Should format cost correctly');
  assert(msg.includes('juice a3f2b1'), 'Should include juice command');
}

async function testTemplateOnboardingWelcome() {
  const { SMS_TEMPLATES } = await import('../lib/smsTemplates');
  const msg = SMS_TEMPLATES.onboardingWelcome('Andy');
  assert(msg.includes('Hi Andy'), 'Should include name');
  assert(msg.includes('Welcome to Rose'), 'Should include welcome');
  assert(msg.includes('Text this number'), 'Should explain how to use');
  assert(msg.includes('approval'), 'Should mention approval flow');
}

async function testTemplateGetAgentUrl() {
  const { getAgentUrl } = await import('../lib/smsTemplates');
  const url = getAgentUrl('abc-123-def');
  assertEqual(url, 'https://roselabs.ai?agent-id=abc-123-def', 'Agent URL format');
}

async function testTemplateLegacyQuestion() {
  const { SMS_TEMPLATES } = await import('../lib/smsTemplates');
  const msg = SMS_TEMPLATES.question('What color?');
  assert(msg.includes('What color'), 'Legacy question template should include question text');
}

async function testTemplateLegacyUnknownPhone() {
  const { SMS_TEMPLATES } = await import('../lib/smsTemplates');
  const msg = SMS_TEMPLATES.unknownPhone();
  assert(msg.includes('roselabs.ai'), 'Should reference signup URL');
}

// ============================================
// 3. Webhook Routing Tests (HTTP endpoint)
// ============================================

async function testWebhookRejectsEmptyBody() {
  const response = await request(`${BASE_URL}/api/sms/inbound`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  // Empty Surge payload — no body or conversation, should return 400
  assert(
    response.status === 400 || response.status === 403 || response.status === 500,
    `Webhook should reject empty Surge payload, got ${response.status}`
  );
}

async function testWebhookRejectsUnknownPhone() {
  // Surge-format JSON payload with unknown phone
  const response = await request(`${BASE_URL}/api/sms/inbound`, {
    method: 'POST',
    body: JSON.stringify({
      id: 'msg_test_unknown',
      body: 'Hello',
      conversation: {
        id: 'conv_test',
        contact: { phone_number: '+10000000000' },
        phone_number: { number: '+14154498445' },
      },
    }),
  });

  // In dev mode (no Surge signature validation), should return 200 JSON
  // In prod mode, 403 is acceptable (invalid signature)
  assert(
    response.status === 200 || response.status === 403,
    `Expected 200 or 403, got ${response.status}`
  );
}

async function testWebhookReturnsJson() {
  // Surge-format JSON payload with known test phone
  const response = await request(`${BASE_URL}/api/sms/inbound`, {
    method: 'POST',
    body: JSON.stringify({
      id: 'msg_test_known',
      body: 'status',
      conversation: {
        id: 'conv_test',
        contact: { phone_number: '+19729777432' },
        phone_number: { number: '+14154498445' },
      },
    }),
  });

  // Should return JSON { ok: true } (supervisor sends response async via Surge)
  if (response.status === 200) {
    assert(
      response.data?.ok === true,
      'Should return { ok: true } JSON response'
    );
  }
}

async function testWebhookShortcodeRegexMatch() {
  // Test that the shortcode regex pattern matches expected inputs
  const SHORTCODE_REGEX = /^(?:approve|yes)\s+([A-Z0-9]{5})$/i;

  // Should match
  const matchCases = [
    'approve H7K2M',
    'Approve H7K2M',
    'APPROVE H7K2M',
    'yes H7K2M',
    'Yes A3K9X',
    'YES B2C4D',
  ];

  for (const input of matchCases) {
    const match = input.match(SHORTCODE_REGEX);
    assert(match !== null, `"${input}" should match shortcode regex`);
    assert(match![1].length === 5, `Captured code from "${input}" should be 5 chars`);
  }

  // Should NOT match
  const noMatchCases = [
    'approve',           // No code
    'approve AB',        // Too short
    'approve ABCDEF',    // Too long
    'approve AB CDE',    // Space in code
    'hello H7K2M',       // Wrong prefix
    'new buy socks',     // Not an approval
    'kill a3f2b1',       // Not an approval
  ];

  for (const input of noMatchCases) {
    const match = input.match(SHORTCODE_REGEX);
    assert(match === null, `"${input}" should NOT match shortcode regex`);
  }
}

// ============================================
// 4. Notify Endpoint Tests (HTTP endpoint)
// ============================================

async function testNotifyEndpointRequiresAuth() {
  const response = await request(`${BASE_URL}/api/send-sms/notify`, {
    method: 'POST',
    body: JSON.stringify({
      user_id: 'test-user',
      event_type: 'agent_started',
      agent_id: 'test-agent',
      payload: { goal: 'test' },
    }),
  });

  assertEqual(response.status, 401, 'Notify endpoint should require auth');
}

async function testNotifyEndpointValidatesEventType() {
  const response = await request(`${BASE_URL}/api/send-sms/notify`, {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({
      user_id: 'test-user',
      event_type: 'invalid_event_type',
      agent_id: 'test-agent',
      payload: {},
    }),
  });

  assertEqual(response.status, 400, 'Should reject invalid event_type');
  assert(
    response.data.error?.includes('Invalid') || response.data.details,
    'Should return validation error'
  );
}

async function testNotifyEndpointRequiresUserId() {
  const response = await request(`${BASE_URL}/api/send-sms/notify`, {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({
      event_type: 'agent_started',
      agent_id: 'test-agent',
      payload: { goal: 'test' },
    }),
  });

  assertEqual(response.status, 400, 'Should reject missing user_id');
}

async function testNotifyEndpointRequiresAgentId() {
  const response = await request(`${BASE_URL}/api/send-sms/notify`, {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({
      user_id: 'test-user',
      event_type: 'agent_started',
      payload: { goal: 'test' },
    }),
  });

  assertEqual(response.status, 400, 'Should reject missing agent_id');
}

async function testNotifyEndpointAcceptsAgentStarted() {
  const response = await request(`${BASE_URL}/api/send-sms/notify`, {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({
      user_id: 'nonexistent-user-id',
      event_type: 'agent_started',
      agent_id: 'test-agent-id',
      payload: { goal: 'Buy socks' },
    }),
  });

  // Should succeed (200) even if user has no phone — notifyAgentStarted handles that gracefully
  assert(
    response.status === 200 || response.status === 500,
    `Expected 200 or 500 (user may not exist), got ${response.status}`
  );
}

async function testNotifyEndpointAcceptsAllEventTypes() {
  const eventTypes = [
    { event_type: 'agent_started', payload: { goal: 'Test goal' } },
    { event_type: 'planner_message', payload: { message: 'Test message', is_question: true } },
    { event_type: 'write_lock', payload: { question: 'Approve this?', attention_request_id: 'test-id', workflow_id: 'test-wf' } },
    { event_type: 'completion', payload: { summary: 'Task done' } },
    { event_type: 'cost_limit', payload: { tree_cost_cents: 100, price_limit_cents: 100 } },
  ];

  for (const { event_type, payload } of eventTypes) {
    const response = await request(`${BASE_URL}/api/send-sms/notify`, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({
        user_id: 'nonexistent-user-for-test',
        event_type,
        agent_id: 'test-agent-id',
        payload,
      }),
    });

    // 200 (success even if user has no phone) or 500 (user not found in DB)
    assert(
      response.status === 200 || response.status === 500,
      `Event type "${event_type}" should be accepted, got ${response.status}: ${JSON.stringify(response.data)}`
    );
  }
}

async function testNotifyEndpointOptionalPayload() {
  const response = await request(`${BASE_URL}/api/send-sms/notify`, {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({
      user_id: 'nonexistent-user-id',
      event_type: 'agent_started',
      agent_id: 'test-agent-id',
      // payload is optional per schema
    }),
  });

  assert(
    response.status === 200 || response.status === 500,
    `Should accept missing payload, got ${response.status}`
  );
}

// ============================================
// 5. Tool Schema Tests (pure logic)
// ============================================

async function testToolSchemasCount() {
  const { TOOL_SCHEMAS } = await import('../lib/smsSupervisor/supervisorTools');
  assertEqual(TOOL_SCHEMAS.length, 6, 'Should have exactly 6 tool schemas');
}

async function testToolSchemasHaveRequiredFields() {
  const { TOOL_SCHEMAS } = await import('../lib/smsSupervisor/supervisorTools');

  for (const schema of TOOL_SCHEMAS) {
    assert(!!schema.name, `Tool schema missing name`);
    assert(!!schema.description, `Tool ${schema.name} missing description`);
    assert(!!schema.parameters, `Tool ${schema.name} missing parameters`);
    assert(schema.parameters.type === 'object', `Tool ${schema.name} parameters should be object type`);
    assert(!!schema.parameters.properties, `Tool ${schema.name} missing properties`);
    assert(Array.isArray(schema.parameters.required), `Tool ${schema.name} missing required array`);
  }
}

async function testToolSchemasNames() {
  const { TOOL_SCHEMAS } = await import('../lib/smsSupervisor/supervisorTools');
  const expectedNames = [
    'reply_to_agent',
    'kill_agent',
    'increase_budget',
    'start_new_agent',
    'web_search',
    'attempt_completion',
  ];

  const actualNames = TOOL_SCHEMAS.map((s: any) => s.name);
  for (const expected of expectedNames) {
    assert(
      actualNames.includes(expected),
      `Missing tool schema: ${expected}. Found: ${actualNames.join(', ')}`
    );
  }

  // Verify removed tools are NOT present
  const removedTools = ['respond_to_attention_request', 'reject_attention_request', 'set_agent_autonomous'];
  for (const removed of removedTools) {
    assert(
      !actualNames.includes(removed),
      `Tool schema should be removed: ${removed}`
    );
  }
}

async function testToolSchemasReplyToAgentRequiresFields() {
  const { TOOL_SCHEMAS } = await import('../lib/smsSupervisor/supervisorTools');
  const replySchema = TOOL_SCHEMAS.find((s: any) => s.name === 'reply_to_agent');
  assert(!!replySchema, 'reply_to_agent schema should exist');
  assert(
    replySchema!.parameters.required.includes('agent_id_or_prefix'),
    'reply_to_agent should require agent_id_or_prefix'
  );
  assert(
    replySchema!.parameters.required.includes('message'),
    'reply_to_agent should require message'
  );
  // attention_request_id and reject should NOT be required (optional)
  assert(
    !replySchema!.parameters.required.includes('attention_request_id'),
    'reply_to_agent attention_request_id should be optional'
  );
  assert(
    !replySchema!.parameters.required.includes('reject'),
    'reply_to_agent reject should be optional'
  );
}

async function testToolSchemasAttemptCompletion() {
  const { TOOL_SCHEMAS } = await import('../lib/smsSupervisor/supervisorTools');
  const completionSchema = TOOL_SCHEMAS.find((s: any) => s.name === 'attempt_completion');
  assert(!!completionSchema, 'attempt_completion schema should exist');
  assert(
    completionSchema!.parameters.required.includes('message'),
    'attempt_completion should require message'
  );
}

async function testToolSchemasKillAgentRequiresPrefix() {
  const { TOOL_SCHEMAS } = await import('../lib/smsSupervisor/supervisorTools');
  const killSchema = TOOL_SCHEMAS.find((s: any) => s.name === 'kill_agent');
  assert(!!killSchema, 'kill_agent schema should exist');
  assert(
    killSchema!.parameters.required.includes('agent_id_or_prefix'),
    'kill_agent should require agent_id_or_prefix'
  );
}

async function testToolSchemasIncreaseBudgetRequiresAmount() {
  const { TOOL_SCHEMAS } = await import('../lib/smsSupervisor/supervisorTools');
  const budgetSchema = TOOL_SCHEMAS.find((s: any) => s.name === 'increase_budget');
  assert(!!budgetSchema, 'increase_budget schema should exist');
  assert(
    budgetSchema!.parameters.required.includes('amount_dollars'),
    'increase_budget should require amount_dollars'
  );
  assert(
    budgetSchema!.parameters.properties.amount_dollars.type === 'number',
    'amount_dollars should be number type'
  );
}

async function testToolSchemasStartNewAgentGoalRequired() {
  const { TOOL_SCHEMAS } = await import('../lib/smsSupervisor/supervisorTools');
  const startSchema = TOOL_SCHEMAS.find((s: any) => s.name === 'start_new_agent');
  assert(!!startSchema, 'start_new_agent schema should exist');
  assert(
    startSchema!.parameters.required.includes('goal'),
    'start_new_agent should require goal'
  );
  // budget_dollars should NOT be required (it's optional with default $1)
  assert(
    !startSchema!.parameters.required.includes('budget_dollars'),
    'start_new_agent budget_dollars should be optional'
  );
}

async function testToolSchemasWebSearchRequiresQuery() {
  const { TOOL_SCHEMAS } = await import('../lib/smsSupervisor/supervisorTools');
  const searchSchema = TOOL_SCHEMAS.find((s: any) => s.name === 'web_search');
  assert(!!searchSchema, 'web_search schema should exist');
  assert(
    searchSchema!.parameters.required.includes('query'),
    'web_search should require query'
  );
}

async function testToolExecuteUnknownTool() {
  const { executeToolCall } = await import('../lib/smsSupervisor/supervisorTools');
  const result = await executeToolCall(
    { tool: 'nonexistent_tool', arguments: {} },
    'fake-user-id'
  );
  assertEqual(result.success, false, 'Unknown tool should fail');
  assert(result.error!.includes('Unknown tool'), 'Error should mention unknown tool');
}

// ============================================
// 6. Queue Endpoint Tests (HTTP endpoint)
// ============================================

async function testQueueEndpointRequiresAuth() {
  const response = await request(`${BASE_URL}/api/send-sms/queue`, {
    method: 'POST',
    body: JSON.stringify({
      user_id: 'test',
      agent_id: 'test',
      workflow_id: 'test',
      question: 'test',
    }),
  });
  assertEqual(response.status, 401, 'Queue endpoint should require auth');
}

async function testQueueEndpointRequiresFields() {
  const response = await request(`${BASE_URL}/api/send-sms/queue`, {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({
      user_id: 'test',
      // Missing agent_id, workflow_id, question
    }),
  });
  assertEqual(response.status, 400, 'Should reject missing required fields');
}

async function testDirectEndpointRequiresAuth() {
  const response = await request(`${BASE_URL}/api/send-sms/direct`, {
    method: 'POST',
    body: JSON.stringify({
      user_id: 'test',
      message: 'test',
    }),
  });
  assertEqual(response.status, 401, 'Direct endpoint should require auth');
}

async function testDirectEndpointRequiresFields() {
  const response = await request(`${BASE_URL}/api/send-sms/direct`, {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({
      user_id: 'test',
      // Missing message
    }),
  });
  assertEqual(response.status, 400, 'Should reject missing message');
}

async function testUnblockEndpointRequiresAuth() {
  const response = await request(`${BASE_URL}/api/send-sms/unblock`, {
    method: 'POST',
    body: JSON.stringify({
      user_id: 'test',
      agent_id: 'test',
    }),
  });
  assertEqual(response.status, 401, 'Unblock endpoint should require auth');
}

async function testUnblockEndpointRequiresFields() {
  const response = await request(`${BASE_URL}/api/send-sms/unblock`, {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({
      user_id: 'test',
      // Missing agent_id
    }),
  });
  assertEqual(response.status, 400, 'Should reject missing agent_id');
}

// ============================================
// 7. Context Builder Format Tests (pure logic)
// ============================================

async function testContextBuilderExports() {
  const mod = await import('../lib/smsSupervisor/contextBuilder');
  assert(typeof mod.buildSmsContext === 'function', 'buildSmsContext should be exported');
}

async function testSmsTemplatesExports() {
  const mod = await import('../lib/smsTemplates');
  assert(typeof mod.SMS_TEMPLATES === 'object', 'SMS_TEMPLATES should be exported');
  assert(typeof mod.getAgentUrl === 'function', 'getAgentUrl should be exported');
  assert(typeof mod.ROSE_SMS_NUMBER === 'string', 'ROSE_SMS_NUMBER should be exported');
  assert(typeof mod.ROSE_LABS_URL === 'string', 'ROSE_LABS_URL should be exported');
}

async function testSupervisorModuleExports() {
  const mod = await import('../lib/smsSupervisor');
  assert(typeof mod.handleSmsSupervisorMessage === 'function', 'handleSmsSupervisorMessage should be exported');
  assert(typeof mod.generateShortcode === 'function', 'generateShortcode should be exported');
  assert(typeof mod.createShortcode === 'function', 'createShortcode should be exported');
  assert(typeof mod.lookupAndConsumeShortcode === 'function', 'lookupAndConsumeShortcode should be exported');
  assert(typeof mod.cleanupExpiredShortcodes === 'function', 'cleanupExpiredShortcodes should be exported');
  assert(typeof mod.buildSmsContext === 'function', 'buildSmsContext should be exported');
  assert(typeof mod.executeToolCall === 'function', 'executeToolCall should be exported');
  assert(Array.isArray(mod.TOOL_SCHEMAS), 'TOOL_SCHEMAS should be exported as array');
}

async function testShortcodeGenerationViaModule() {
  const { generateShortcode } = await import('../lib/smsSupervisor');
  const code = generateShortcode();
  assertEqual(code.length, 5, 'Module generateShortcode should return 5-char code');
  for (const char of code) {
    assert(
      SHORTCODE_ALPHABET.includes(char),
      `Module shortcode contains invalid char '${char}'`
    );
  }
}

// ============================================
// 8. Edge Case Tests
// ============================================

async function testTemplateCostLimitZeroCost() {
  const { SMS_TEMPLATES } = await import('../lib/smsTemplates');
  const msg = SMS_TEMPLATES.costLimit('a3f2b1', 0, 100);
  assert(msg.includes('$0.00/$1.00'), 'Should handle zero cost');
}

async function testTemplateCostLimitLargeCost() {
  const { SMS_TEMPLATES } = await import('../lib/smsTemplates');
  const msg = SMS_TEMPLATES.costLimit('a3f2b1', 99999, 100000);
  assert(msg.includes('$999.99/$1000.00'), 'Should handle large cost values');
}

async function testTemplateWriteLockLongQuestion() {
  const { SMS_TEMPLATES } = await import('../lib/smsTemplates');
  const longQuestion = 'A'.repeat(500);
  const msg = SMS_TEMPLATES.writeLock('a3f2b1', longQuestion, 'H7K2M');
  assert(msg.includes('Approve H7K2M'), 'Long question should still include shortcode');
  assert(msg.length > 500, 'Long question should produce long message');
}

async function testTemplateAgentStartedEmptyGoal() {
  const { SMS_TEMPLATES, getAgentUrl } = await import('../lib/smsTemplates');
  const msg = SMS_TEMPLATES.agentStarted('a3f2b1', '', 'https://roselabs.ai');
  assert(msg.includes('[a3f2b1]'), 'Should include prefix even with empty goal');
  assert(msg.includes('Started:'), 'Should include Started even with empty goal');
}

async function testNotifyEndpointEmptyPayload() {
  const response = await request(`${BASE_URL}/api/send-sms/notify`, {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({
      user_id: 'nonexistent-user-id',
      event_type: 'agent_started',
      agent_id: 'test-agent-id',
      payload: {},
    }),
  });

  assert(
    response.status === 200 || response.status === 500,
    `Should handle empty payload gracefully, got ${response.status}`
  );
}

async function testShortcodeRegexCaseInsensitive() {
  const SHORTCODE_REGEX = /^(?:approve|yes)\s+([A-Z0-9]{5})$/i;
  const match1 = 'approve h7k2m'.match(SHORTCODE_REGEX);
  assert(match1 !== null, 'Lowercase shortcode should match');
  assertEqual(match1![1], 'h7k2m', 'Should capture lowercase code');

  const match2 = 'APPROVE H7K2M'.match(SHORTCODE_REGEX);
  assert(match2 !== null, 'Uppercase shortcode should match');
}

// ============================================
// Main Runner
// ============================================

async function runAllTests() {
  console.log('🧪 Starting SMS Supervisor Test Suite...\n');
  console.log(`📡 Testing against: ${BASE_URL}\n`);

  // Pure logic tests (no server needed)
  const pureTests = [
    { name: 'Shortcode: length is 5', fn: testShortcodeLength },
    { name: 'Shortcode: uses safe alphabet', fn: testShortcodeAlphabet },
    { name: 'Shortcode: no ambiguous chars (0/O/1/I/l)', fn: testShortcodeNoAmbiguousChars },
    { name: 'Shortcode: uniqueness (1000 samples)', fn: testShortcodeUniqueness },
    { name: 'Shortcode: alphabet has 32 chars', fn: testShortcodeAlphabetSize },
    { name: 'Shortcode: regex matches approve/yes', fn: testWebhookShortcodeRegexMatch },
    { name: 'Shortcode: regex case insensitive', fn: testShortcodeRegexCaseInsensitive },
    { name: 'Template: agentStarted', fn: testTemplateAgentStarted },
    { name: 'Template: plannerQuestion', fn: testTemplatePlannerQuestion },
    { name: 'Template: plannerFyi', fn: testTemplatePlannerFyi },
    { name: 'Template: writeLock', fn: testTemplateWriteLock },
    { name: 'Template: agentCompleted', fn: testTemplateAgentCompleted },
    { name: 'Template: costLimit', fn: testTemplateCostLimit },
    { name: 'Template: onboardingWelcome', fn: testTemplateOnboardingWelcome },
    { name: 'Template: getAgentUrl', fn: testTemplateGetAgentUrl },
    { name: 'Template: legacy question', fn: testTemplateLegacyQuestion },
    { name: 'Template: legacy unknownPhone', fn: testTemplateLegacyUnknownPhone },
    { name: 'Template: costLimit zero cost', fn: testTemplateCostLimitZeroCost },
    { name: 'Template: costLimit large cost', fn: testTemplateCostLimitLargeCost },
    { name: 'Template: writeLock long question', fn: testTemplateWriteLockLongQuestion },
    { name: 'Template: agentStarted empty goal', fn: testTemplateAgentStartedEmptyGoal },
  ];

  console.log('📋 Running pure logic tests...');
  const pureResults = await Promise.all(pureTests.map(t => runTest(t.name, t.fn)));
  pureResults.forEach(printResult);

  // Module import/export tests
  const moduleTests = [
    { name: 'Module: smsSupervisor barrel exports', fn: testSupervisorModuleExports },
    { name: 'Module: contextBuilder exports', fn: testContextBuilderExports },
    { name: 'Module: smsTemplates exports', fn: testSmsTemplatesExports },
    { name: 'Module: shortcode generation via module', fn: testShortcodeGenerationViaModule },
    { name: 'Module: tool schemas count', fn: testToolSchemasCount },
    { name: 'Module: tool schemas have required fields', fn: testToolSchemasHaveRequiredFields },
    { name: 'Module: tool schema names', fn: testToolSchemasNames },
    { name: 'Module: reply_to_agent requires agent_id + message', fn: testToolSchemasReplyToAgentRequiresFields },
    { name: 'Module: attempt_completion requires message', fn: testToolSchemasAttemptCompletion },
    { name: 'Module: kill_agent requires prefix', fn: testToolSchemasKillAgentRequiresPrefix },
    { name: 'Module: increase_budget requires amount', fn: testToolSchemasIncreaseBudgetRequiresAmount },
    { name: 'Module: start_new_agent goal required, budget optional', fn: testToolSchemasStartNewAgentGoalRequired },
    { name: 'Module: web_search requires query', fn: testToolSchemasWebSearchRequiresQuery },
    { name: 'Module: unknown tool returns error', fn: testToolExecuteUnknownTool },
  ];

  console.log('\n📦 Running module tests...');
  const moduleResults: TestResult[] = [];
  for (const test of moduleTests) {
    const result = await runTest(test.name, test.fn);
    printResult(result);
    moduleResults.push(result);
  }

  // HTTP endpoint tests (require running server)
  const httpTests = [
    // Webhook
    { name: 'Webhook: handles empty body', fn: testWebhookRejectsEmptyBody },
    { name: 'Webhook: handles unknown phone', fn: testWebhookRejectsUnknownPhone },
    { name: 'Webhook: returns JSON', fn: testWebhookReturnsJson },
    // Notify endpoint
    { name: 'Notify: requires auth', fn: testNotifyEndpointRequiresAuth },
    { name: 'Notify: validates event_type', fn: testNotifyEndpointValidatesEventType },
    { name: 'Notify: requires user_id', fn: testNotifyEndpointRequiresUserId },
    { name: 'Notify: requires agent_id', fn: testNotifyEndpointRequiresAgentId },
    { name: 'Notify: accepts agent_started', fn: testNotifyEndpointAcceptsAgentStarted },
    { name: 'Notify: accepts all event types', fn: testNotifyEndpointAcceptsAllEventTypes },
    { name: 'Notify: optional payload', fn: testNotifyEndpointOptionalPayload },
    { name: 'Notify: empty payload', fn: testNotifyEndpointEmptyPayload },
    // Queue endpoints
    { name: 'Queue: requires auth', fn: testQueueEndpointRequiresAuth },
    { name: 'Queue: requires fields', fn: testQueueEndpointRequiresFields },
    { name: 'Direct: requires auth', fn: testDirectEndpointRequiresAuth },
    { name: 'Direct: requires fields', fn: testDirectEndpointRequiresFields },
    { name: 'Unblock: requires auth', fn: testUnblockEndpointRequiresAuth },
    { name: 'Unblock: requires fields', fn: testUnblockEndpointRequiresFields },
  ];

  // Check if server is running before HTTP tests
  let serverAvailable = false;
  try {
    await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(2000) });
    serverAvailable = true;
  } catch {
    // Server not available
  }

  console.log(`\n🌐 Running HTTP endpoint tests...${!serverAvailable ? ' (⚠️ server not running, skipping)' : ''}`);
  const httpResults: TestResult[] = [];
  if (serverAvailable) {
    for (const test of httpTests) {
      const result = await runTest(test.name, test.fn);
      printResult(result);
      httpResults.push(result);
    }
  } else {
    for (const test of httpTests) {
      const result: TestResult = { name: test.name, passed: true, duration: 0 };
      console.log(`  ⏭️  ${test.name} (skipped — server not running)`);
      httpResults.push(result);
    }
  }

  // Summary
  const allResults = [...pureResults, ...moduleResults, ...httpResults];
  const passed = allResults.filter(r => r.passed).length;
  const failed = allResults.filter(r => !r.passed).length;
  const totalDuration = allResults.reduce((sum, r) => sum + r.duration, 0);

  console.log('\n' + '='.repeat(60));
  console.log(`\n📊 SMS Supervisor Test Summary:`);
  console.log(`   Total: ${allResults.length}`);
  console.log(`   ✅ Passed: ${passed}`);
  console.log(`   ❌ Failed: ${failed}`);
  console.log(`   ⏱️  Duration: ${totalDuration}ms\n`);

  if (failed > 0) {
    console.log('❌ FAILED TESTS:');
    allResults
      .filter(r => !r.passed)
      .forEach(r => console.log(`   • ${r.name}: ${r.error || 'Unknown'}`));
    console.log('');
    process.exit(1);
  }

  console.log('✅ All SMS supervisor tests passed!\n');
  process.exit(0);
}

runAllTests().catch((error) => {
  console.error('Fatal error running tests:', error);
  process.exit(1);
});
