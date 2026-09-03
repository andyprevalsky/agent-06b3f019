import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BASE_SYSTEM_PROMPT,
  DEFAULT_CALL_ASSISTANT_CONFIG,
  buildCallAssistantConfig,
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
  assert.equal(
    isIvrNavigationPrompt('Call the IVR and press 1 for delivery status.'),
    true
  );
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
