import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BASE_SYSTEM_PROMPT,
  DEFAULT_CALL_ASSISTANT_CONFIG,
  HOLD_QUEUE_MAX_DURATION_SECONDS,
  HOLD_QUEUE_SILENCE_TIMEOUT_SECONDS,
  buildCallAssistantConfig,
  isHoldQueuePrompt,
  isIvrNavigationPrompt,
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
  assert.equal(assistant.firstMessage, 'Hello, how are you today?');
  assert.equal(assistant.firstMessageMode, undefined);
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

test('isHoldQueuePrompt ignores base prompt alone but matches hold-queue briefs', () => {
  assert.equal(isHoldQueuePrompt(BASE_SYSTEM_PROMPT), false);
  assert.equal(isHoldQueuePrompt('Call Jordan and collect their mailing address.'), false);
  assert.equal(
    isHoldQueuePrompt('Stay on the line through the hold queue until a representative answers.'),
    true
  );
  assert.equal(isHoldQueuePrompt('Please hold. Estimated wait is 3 hours.'), true);
});

test('buildCallAssistantConfig waits for hold-queue callee to speak first', () => {
  const assistant = buildCallAssistantConfig(
    'Stay on the line. The automated hold queue will say the estimated wait is 3 hours.',
    { confirmation_code: 'string' }
  );
  assert.equal(assistant.firstMessage, '');
  assert.equal(assistant.firstMessageMode, 'assistant-waits-for-user');
  assert.equal(assistant.silenceTimeoutSeconds, HOLD_QUEUE_SILENCE_TIMEOUT_SECONDS);
  assert.equal(assistant.maxDurationSeconds, HOLD_QUEUE_MAX_DURATION_SECONDS);
  assert.equal(HOLD_QUEUE_SILENCE_TIMEOUT_SECONDS, 3600);
  assert.equal(HOLD_QUEUE_MAX_DURATION_SECONDS, 12600);
});
