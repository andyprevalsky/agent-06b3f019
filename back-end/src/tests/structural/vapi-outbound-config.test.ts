import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BASE_SYSTEM_PROMPT,
  DEFAULT_CALL_ASSISTANT_CONFIG,
  HOLD_MAX_SECONDS,
  OUTBOUND_ASSISTANT_MODEL,
  WAIT_FOR_HUMAN_TOOL_NAME,
  buildCallAssistantConfig,
  isIvrNavigationPrompt,
  resolveHoldPublicBaseUrl,
  resolveHoldRuntimeConfig,
} from '../../domains/vapi/config';

test('outbound Vapi assistant includes dtmf tool for IVR navigation', () => {
  const tools = (DEFAULT_CALL_ASSISTANT_CONFIG.model as { tools?: { type: string }[] }).tools ?? [];
  assert.ok(
    tools.some((tool) => tool.type === 'dtmf'),
    `Expected dtmf tool in DEFAULT_CALL_ASSISTANT_CONFIG, got ${JSON.stringify(tools)}`
  );
  assert.ok(
    tools.some((tool) => tool.type === 'endCall'),
    `Expected endCall tool in DEFAULT_CALL_ASSISTANT_CONFIG, got ${JSON.stringify(tools)}`
  );
});

test('outbound Vapi base prompt instructs DTMF for call-tree navigation', () => {
  assert.match(BASE_SYSTEM_PROMPT, /use the dtmf function/i);
  assert.match(BASE_SYSTEM_PROMPT, /Never speak digits aloud/i);
  assert.match(BASE_SYSTEM_PROMPT, /Do not put a w pause between every single digit/i);
  assert.match(BASE_SYSTEM_PROMPT, /ww245w133w8820#/);
  assert.match(BASE_SYSTEM_PROMPT, /stay silent and listen for the IVR/i);
});

test('isIvrNavigationPrompt ignores base prompt alone but matches IVR briefs', () => {
  assert.equal(isIvrNavigationPrompt(BASE_SYSTEM_PROMPT), false);
  assert.equal(
    isIvrNavigationPrompt(
      'Navigate the automated phone menu with keypad DTMF. Enter tracking number 2451338820 followed by #.'
    ),
    true
  );
  assert.equal(isIvrNavigationPrompt('Call Jordan and collect their mailing address.'), false);
  assert.equal(isIvrNavigationPrompt('Call the IVR and press 1 for delivery status.'), true);
});

test('buildCallAssistantConfig preserves dtmf tool on outbound calls', () => {
  const assistant = buildCallAssistantConfig('Collect the contact name.', { status: 'string' });
  const tools = (assistant.model as { tools?: { type: string }[] }).tools ?? [];
  assert.ok(
    tools.some((tool) => tool.type === 'dtmf'),
    `Expected dtmf tool in built assistant config, got ${JSON.stringify(tools)}`
  );
  const systemMessage = (
    assistant.model as { messages?: { role?: string; content?: string }[] }
  ).messages?.find((message) => message.role === 'system')?.content;
  assert.match(String(systemMessage), /Collect the contact name\./);
  assert.equal(assistant.firstMessage, undefined);
  assert.equal(assistant.firstMessageMode, 'assistant-speaks-first-with-model-generated-message');
});

test('buildCallAssistantConfig waits for IVR callee to speak first', () => {
  const assistant = buildCallAssistantConfig(
    'Navigate keypad IVR and enter tracking number 2451338820.',
    { status: 'string' },
    undefined,
    { calleeSpeaksFirst: true }
  );
  assert.equal(assistant.firstMessage, '');
  assert.equal(assistant.firstMessageMode, 'assistant-waits-for-user');
});

test('outbound assistant runs on gpt-4.1-mini', () => {
  assert.equal(OUTBOUND_ASSISTANT_MODEL, 'gpt-4.1-mini');
  const assistant = buildCallAssistantConfig('Collect the contact name.', { status: 'string' });
  assert.equal((assistant.model as { model?: string }).model, 'gpt-4.1-mini');
});

type ToolShape = {
  type?: string;
  function?: { name?: string; parameters?: { required?: string[] } };
  server?: { url?: string; timeoutSeconds?: number };
};

function toolsOf(assistant: Record<string, unknown>): ToolShape[] {
  return (assistant.model as { tools?: ToolShape[] }).tools ?? [];
}

test('wait_for_human is offered only with a hold webhook, alongside dtmf and endCall', () => {
  const plain = buildCallAssistantConfig('Call Jordan.', { status: 'string' });
  assert.equal(
    toolsOf(plain).some((tool) => tool.function?.name === WAIT_FOR_HUMAN_TOOL_NAME),
    false
  );

  const url = 'https://api.example.test/api/vapi/hold/tool?session=s1&token=t1';
  const holdCapable = buildCallAssistantConfig(
    'Call Air Canada.',
    { status: 'string' },
    undefined,
    {
      waitForHumanToolUrl: url,
    }
  );
  const tools = toolsOf(holdCapable);
  const waitForHuman = tools.find((tool) => tool.function?.name === WAIT_FOR_HUMAN_TOOL_NAME);
  assert.ok(waitForHuman, `Expected wait_for_human tool, got ${JSON.stringify(tools)}`);
  assert.equal(waitForHuman.type, 'function');
  assert.equal(waitForHuman.server?.url, url);
  assert.deepEqual(waitForHuman.function?.parameters?.required, []);
  assert.ok(tools.some((tool) => tool.type === 'dtmf'));
  assert.ok(tools.some((tool) => tool.type === 'endCall'));
  // Calls keep the normal per-segment limits; the hold itself is not Vapi time.
  assert.equal(holdCapable.silenceTimeoutSeconds, 30);
  assert.equal(holdCapable.maxDurationSeconds, 600);
  assert.equal(
    toolsOf(DEFAULT_CALL_ASSISTANT_CONFIG).some(
      (tool) => tool.function?.name === WAIT_FOR_HUMAN_TOOL_NAME
    ),
    false,
    'adding wait_for_human must not mutate the shared default tool list'
  );
});

test('hold webhooks use a public https origin, never loopback', () => {
  assert.equal(resolveHoldPublicBaseUrl({}), null);
  assert.equal(resolveHoldPublicBaseUrl({ BACKEND_URL: 'http://localhost:4123' }), null);
  assert.equal(resolveHoldPublicBaseUrl({ BACKEND_URL: 'https://127.0.0.1:3001' }), null);
  assert.equal(
    resolveHoldPublicBaseUrl({
      BACKEND_URL: 'http://localhost:4123',
      PUBLIC_BASE_URL: 'https://tunnel.example.test/',
    }),
    'https://tunnel.example.test'
  );
  assert.equal(
    resolveHoldPublicBaseUrl({
      PHONE_HOLD_PUBLIC_URL: 'https://hold.example.test',
      PUBLIC_BASE_URL: 'https://tunnel.example.test',
    }),
    'https://hold.example.test'
  );
  assert.equal(
    resolveHoldPublicBaseUrl({ RENDER_EXTERNAL_URL: 'https://navi.onrender.com' }),
    'https://navi.onrender.com'
  );
});

test('hold parking needs every dependency and honors the kill switch', () => {
  const env = {
    BACKEND_URL: 'https://api.example.test',
    TWILIO_ACCOUNT_SID: 'AC123',
    TWILIO_AUTH_TOKEN: 'token',
    ELEVENLABS_API_KEY: 'xi',
    BACKEND_API_KEY: 'secret',
  };
  assert.deepEqual(resolveHoldRuntimeConfig(env), {
    publicBaseUrl: 'https://api.example.test',
    twilioAccountSid: 'AC123',
    twilioAuthToken: 'token',
    elevenLabsApiKey: 'xi',
    tokenSecret: 'secret',
  });
  assert.equal(resolveHoldRuntimeConfig({ ...env, PHONE_HOLD_ENABLED: '0' }), null);
  for (const key of Object.keys(env)) {
    assert.equal(resolveHoldRuntimeConfig({ ...env, [key]: '' }), null, `${key} missing`);
  }
});

test('a parked call is capped at three hours on hold', () => {
  assert.equal(HOLD_MAX_SECONDS, 3 * 60 * 60);
});
