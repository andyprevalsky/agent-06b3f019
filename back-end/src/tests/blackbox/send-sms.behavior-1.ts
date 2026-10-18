import { z } from 'zod';
import {
  request,
  BASE_URL,
  assertStatus,
  apiKeyHeaders,
  assertSchema,
  ErrorSchema,
  TEST_PHONE,
  SendSuccessSchema,
  assert,
  TEST_USER_ID,
  FAKE_AGENT_ID,
  NotifyZodErrorSchema,
  NotifySuccessSchema,
  createNotifyAgent,
  prisma,
} from './send-sms.support';

// ==================== POST / (send SMS) -- CONTRACT ====================
export async function testSend_noAuth() {
  const res = await request(`${BASE_URL}/api/send-sms`, {
    method: 'POST',
    body: JSON.stringify({ phone_number: '+10000000000', message: 'test' }),
  });
  assertStatus(res.status, 401, res.data);
}

export async function testSend_missingPhone() {
  const res = await request(`${BASE_URL}/api/send-sms`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ message: 'test' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorSchema, res.data, 'missing phone');
}

export async function testSend_missingMessage() {
  const res = await request(`${BASE_URL}/api/send-sms`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ phone_number: '+10000000000' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorSchema, res.data, 'missing message');
}

export async function testSend_emptyPhone() {
  const res = await request(`${BASE_URL}/api/send-sms`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ phone_number: '', message: 'test' }),
  });
  assertStatus(res.status, 400, res.data);
}

export async function testSend_emptyMessage() {
  const res = await request(`${BASE_URL}/api/send-sms`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ phone_number: '+10000000000', message: '' }),
  });
  assertStatus(res.status, 400, res.data);
}

export async function testSend_happyPath() {
  const res = await request(`${BASE_URL}/api/send-sms`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      phone_number: TEST_PHONE,
      message: 'blackbox test',
    }),
  });
  if (res.status === 200) {
    const data = assertSchema(SendSuccessSchema, res.data, 'send happy path');
    assert(
      data.phone_number === TEST_PHONE,
      `Expected phone ${TEST_PHONE}, got ${data.phone_number}`
    );
    assert(data.provider === 'surge', `Expected provider surge, got ${data.provider}`);
  } else if (res.status === 500) {
    assertSchema(ErrorSchema, res.data, 'send 500 (Surge not configured)');
  } else {
    assertSchema(ErrorSchema, res.data, `send ${res.status} (Surge error)`);
  }
}

export async function testSend_surgeApiError() {
  const res = await request(`${BASE_URL}/api/send-sms`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      phone_number: TEST_PHONE,
      message: '__BLACKBOX_SURGE_502__',
    }),
  });
  assertStatus(res.status, 502, res.data);
  const data = assertSchema(ErrorSchema, res.data, 'send Surge API error');
  assert(data.error.includes('Surge API error (502)'), `Unexpected error: ${data.error}`);
}

export async function testSend_surgeNetworkFailure() {
  const res = await request(`${BASE_URL}/api/send-sms`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      phone_number: TEST_PHONE,
      message: '__BLACKBOX_SURGE_THROW__',
    }),
  });
  assertStatus(res.status, 500, res.data);
  const data = assertSchema(ErrorSchema, res.data, 'send Surge network failure');
  assert(data.error === 'Failed to send SMS', `Unexpected error: ${data.error}`);
}

export async function testSend_responseContentType() {
  const res = await request(`${BASE_URL}/api/send-sms`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      phone_number: TEST_PHONE,
      message: 'content type test',
    }),
  });
  const ct = res.headers.get('content-type');
  assert(ct !== null && ct.includes('application/json'), `Expected JSON content-type, got: ${ct}`);
}

// ==================== POST /direct -- CONTRACT ====================
export async function testDirect_noAuth() {
  const res = await request(`${BASE_URL}/api/send-sms/direct`, {
    method: 'POST',
    body: JSON.stringify({ user_id: TEST_USER_ID, message: 'test' }),
  });
  assertStatus(res.status, 401, res.data);
}

export async function testDirect_missingBothFields() {
  const res = await request(`${BASE_URL}/api/send-sms/direct`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorSchema, res.data, 'direct missing fields');
}

export async function testDirect_missingUserId() {
  const res = await request(`${BASE_URL}/api/send-sms/direct`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ message: 'test' }),
  });
  assertStatus(res.status, 400, res.data);
}

export async function testDirect_missingMessage() {
  const res = await request(`${BASE_URL}/api/send-sms/direct`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ user_id: TEST_USER_ID }),
  });
  assertStatus(res.status, 400, res.data);
}

export async function testDirect_unknownUser() {
  const res = await request(`${BASE_URL}/api/send-sms/direct`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      user_id: '00000000-0000-0000-0000-000000000000',
      message: 'test',
    }),
  });
  assertStatus(res.status, 400, res.data);
  const data = res.data as { error?: string };
  assert(data.error !== undefined, 'Expected error field for unknown user');
}

export async function testDirect_happyPath() {
  const res = await request(`${BASE_URL}/api/send-sms/direct`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      user_id: TEST_USER_ID,
      message: 'blackbox direct test',
    }),
  });
  if (res.status === 200) {
    const data = res.data as Record<string, unknown>;
    assert(typeof data.success === 'boolean', 'Expected success field in response');
  } else {
    assertStatus(res.status, 500, res.data);
  }
}

// ==================== POST /notify -- CONTRACT ====================
export async function testNotify_noAuth() {
  const res = await request(`${BASE_URL}/api/send-sms/notify`, {
    method: 'POST',
    body: JSON.stringify({
      user_id: TEST_USER_ID,
      event_type: 'completion',
      agent_id: FAKE_AGENT_ID,
    }),
  });
  assertStatus(res.status, 401, res.data);
}

export async function testNotify_emptyBody() {
  const res = await request(`${BASE_URL}/api/send-sms/notify`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
}

export async function testNotify_invalidEventType() {
  const res = await request(`${BASE_URL}/api/send-sms/notify`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      user_id: TEST_USER_ID,
      event_type: 'invalid_event',
      agent_id: FAKE_AGENT_ID,
    }),
  });
  assertStatus(res.status, 400, res.data);
}

export async function testNotify_missingUserId() {
  const res = await request(`${BASE_URL}/api/send-sms/notify`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      event_type: 'completion',
      agent_id: FAKE_AGENT_ID,
    }),
  });
  assertStatus(res.status, 400, res.data);
}

export async function testNotify_missingAgentId() {
  const res = await request(`${BASE_URL}/api/send-sms/notify`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      user_id: TEST_USER_ID,
      event_type: 'completion',
    }),
  });
  assertStatus(res.status, 400, res.data);
}

export async function testNotify_missingEventType() {
  const res = await request(`${BASE_URL}/api/send-sms/notify`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      user_id: TEST_USER_ID,
      agent_id: FAKE_AGENT_ID,
    }),
  });
  assertStatus(res.status, 400, res.data);
}

export async function testNotify_zodErrorShape() {
  const res = await request(`${BASE_URL}/api/send-sms/notify`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      user_id: 123,
      event_type: 'completion',
      agent_id: FAKE_AGENT_ID,
    }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(NotifyZodErrorSchema, res.data, 'Zod error shape');
}

export async function testNotify_allValidEventTypes() {
  const events: { type: string; payload: Record<string, unknown> }[] = [
    { type: 'agent_started', payload: { goal: 'test goal' } },
    {
      type: 'planner_message',
      payload: { message: 'test message', is_question: false },
    },
    {
      type: 'write_lock',
      payload: {
        question: 'approve?',
        attention_request_id: 'test-ar',
        workflow_id: 'test-wf',
      },
    },
    {
      type: 'agentcard_setup',
      payload: { setup_url: 'https://rose.test/api/agentcard/connect?user=user-123' },
    },
    { type: 'completion', payload: { summary: 'test summary' } },
    {
      type: 'cost_limit',
      payload: { tree_cost_cents: 100, price_limit_cents: 500 },
    },
  ];
  for (const { type, payload } of events) {
    const res = await request(`${BASE_URL}/api/send-sms/notify`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({
        user_id: TEST_USER_ID,
        event_type: type,
        agent_id: FAKE_AGENT_ID,
        payload,
      }),
    });
    assert(
      res.status === 200 || res.status === 500,
      `Event '${type}': expected 200 or 500, got ${res.status}: ` +
        `${JSON.stringify(res.data).substring(0, 200)}`
    );
    if (res.status === 200) {
      assertSchema(NotifySuccessSchema, res.data, `notify ${type}`);
    }
  }
}

export async function testNotify_completionHappyPath() {
  const res = await request(`${BASE_URL}/api/send-sms/notify`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      user_id: TEST_USER_ID,
      event_type: 'completion',
      agent_id: FAKE_AGENT_ID,
      payload: { summary: 'blackbox completion test' },
    }),
  });
  assert(res.status === 200 || res.status === 500, `Expected 200 or 500, got ${res.status}`);
  if (res.status === 200) {
    assertSchema(NotifySuccessSchema, res.data, 'notify completion happy');
  }
}

export async function testNotify_unknownAgentSkipped() {
  const res = await request(`${BASE_URL}/api/send-sms/notify`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      user_id: TEST_USER_ID,
      event_type: 'completion',
      agent_id: crypto.randomUUID(),
      payload: { summary: 'unknown agent skip' },
    }),
  });
  assertStatus(res.status, 200, res.data);
  const data = assertSchema(
    NotifySuccessSchema.extend({
      skipped: z.literal(true),
      reason: z.literal('agent_not_found'),
    }),
    res.data,
    'notify unknown agent skipped'
  );
  assert(data.reason === 'agent_not_found', `Unexpected reason: ${data.reason}`);
}

export async function testNotify_deletedAgentSkipped() {
  const agent = await createNotifyAgent('deleted agent skip');
  try {
    await prisma.agent.update({
      where: { id: agent.id },
      data: { deletedAt: new Date() },
    });
    const res = await request(`${BASE_URL}/api/send-sms/notify`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({
        user_id: TEST_USER_ID,
        event_type: 'completion',
        agent_id: agent.id,
        payload: { summary: 'deleted agent skip' },
      }),
    });
    assertStatus(res.status, 200, res.data);
    const data = assertSchema(
      NotifySuccessSchema.extend({
        skipped: z.literal(true),
        reason: z.literal('agent_deleted'),
      }),
      res.data,
      'notify deleted agent skipped'
    );
    assert(data.reason === 'agent_deleted', `Unexpected reason: ${data.reason}`);
  } finally {
    await prisma.agent.deleteMany({ where: { id: agent.id } });
  }
}

export async function testNotify_responseContentType() {
  const res = await request(`${BASE_URL}/api/send-sms/notify`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      user_id: TEST_USER_ID,
      event_type: 'completion',
      agent_id: FAKE_AGENT_ID,
      payload: { summary: 'ct test' },
    }),
  });
  const ct = res.headers.get('content-type');
  assert(ct !== null && ct.includes('application/json'), `Expected JSON content-type, got: ${ct}`);
}
