/**
 * The SMS supervisor's loop must never speak to the model in the user's voice.
 *
 * In the SMS transcript `role: 'user'` means exactly one thing: an SMS the human
 * typed — that is the only shape `sessionStore.recordInboundSms` ever writes.
 * The tool loop used to append its own control text ("Tool results: …",
 * "Use send_user_message for user-visible text…") as `role: 'user'`, which the
 * model read as a NEW inbound text and politely answered with another outbound
 * SMS. Prod, 2026-07-27: eight "Acknowledged. I am monitoring active agents…"
 * texts for one inbound, the model's own reasoning naming the cause —
 * "User sent the response format reminder. No new task."
 *
 * These tests pin the fix: loop feedback travels on the tool channel only.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SMS_SURFACE_OVERLAY } from '../../providers/smsSupervisor/contextBuilder';
import {
  buildNativeToolFeedbackMessages,
  buildToolFeedbackMessages,
} from '../../providers/smsSupervisor/environmentMessages';
import type { ToolCall, ToolResult } from '../../providers/smsSupervisor/supervisorTools';
import { TOOL_SCHEMAS } from '../../providers/smsSupervisor/supervisorTools.schemas';
import { SUPERVISOR_RESPONSE_SCHEMA } from '../../providers/smsSupervisor/schema';

const HANDLER_SOURCE = readFileSync(
  join(__dirname, '../../providers/smsSupervisor/supervisorHandler.ts'),
  'utf8'
);

function test(name: string, run: () => void): void {
  run();
  process.stdout.write(`PASS sms-supervisor-tool-feedback: ${name}\n`);
}

const feedback = buildToolFeedbackMessages({
  round: 3,
  assistantPayload: '{"reasoning":"r","tool_calls":[]}',
  toolResultSummary: 'Tool results:\n[grep] OK: 2 hits',
  guidance: 'Incorporate these results.',
});

test('never emits a user turn', () => {
  assert.deepEqual(
    feedback.map((message) => message.role),
    ['assistant', 'tool']
  );
  assert.equal(
    feedback.some((message) => message.role === 'user'),
    false
  );
});

test('pairs the tool result with the assistant turn that requested it', () => {
  const [assistant, tool] = feedback;
  const callId = assistant.tool_calls?.[0]?.id;
  assert.equal(callId, 'sms-tool-results-3');
  assert.equal(tool.tool_call_id, callId);
});

test('carries both the results and the guidance to the model', () => {
  assert.ok(feedback[1].content.includes('[grep] OK: 2 hits'));
  assert.ok(feedback[1].content.includes('Incorporate these results.'));
});

test('teaches the complete SMS body limit in the prompt and both tool schema surfaces', () => {
  const sendUserMessage = TOOL_SCHEMAS.find((tool) => tool.name === 'send_user_message');
  const structuredSchema = JSON.stringify(SUPERVISOR_RESPONSE_SCHEMA);
  for (const contract of [
    SMS_SURFACE_OVERLAY,
    sendUserMessage?.parameters.properties.message.description ?? '',
    structuredSchema,
  ]) {
    assert.match(contract, /at most 1600 characters/i);
    assert.match(contract, /spaces, line breaks, and URLs/i);
    assert.match(contract, /actual delivery error/i);
    assert.match(contract, /retry/i);
    assert.match(contract, /do not claim delivery until the send succeeds/i);
  }
});

test('omits the empty results header when a round produced no tool calls', () => {
  const empty = buildToolFeedbackMessages({
    round: 0,
    assistantPayload: '{}',
    toolResultSummary: '',
    guidance: 'That response contained no tool calls.',
  });
  assert.equal(empty[1].content, 'That response contained no tool calls.');
});

test('never appends a synthetic user turn', () => {
  // The only legitimate user turn is the real inbound SMS, built once from
  // `inboundContent`. Any other `role: 'user'` in the loop is control text
  // wearing the human's voice — the exact defect this guards.
  const userTurns = HANDLER_SOURCE.match(/role: 'user'/g) ?? [];
  assert.equal(userTurns.length, 1);
  assert.ok(HANDLER_SOURCE.includes("{ role: 'user', content: inboundContent }"));
});

test('routes every loop nudge through the tool channel', () => {
  assert.doesNotMatch(HANDLER_SOURCE, /messages\.push\(\{\s*role: 'user'/);
  // Rounds with tool calls replay them natively; only a round with no tool
  // call to answer still uses the synthetic tool_results pair.
  const nativeRounds = HANDLER_SOURCE.match(/\.\.\.nativeFeedback\(/g) ?? [];
  const emptyRounds = HANDLER_SOURCE.match(/environment\.buildToolFeedbackMessages\(/g) ?? [];
  assert.equal(nativeRounds.length, 3);
  assert.equal(emptyRounds.length, 1);
  assert.doesNotMatch(
    HANDLER_SOURCE,
    /assistantPayload: JSON\.stringify\(\{\s*reasoning: llmResponse\.reasoning,\s*tool_calls: llmResponse\.tool_calls/
  );
});

// Native tool history (Rose.complete standard): the next round sees the calls
// the model actually made, each answered by its own result, instead of a JSON
// envelope echoed back as assistant text.
const grepCall: ToolCall = { tool: 'grep', arguments: { pattern: 'passport' }, id: 'call_grep' };
const searchCall: ToolCall = { tool: 'web_search', arguments: { query: 'canada eta' } };
const completionCall: ToolCall = { tool: 'attempt_completion', arguments: {} };
const nativeFeedback = buildNativeToolFeedbackMessages({
  round: 2,
  toolCalls: [grepCall, searchCall, completionCall],
  resultsByCall: new Map<ToolCall, ToolResult[]>([
    [grepCall, [{ tool: 'grep', success: true, result: 'Passport: G58219473' }]],
    [searchCall, [{ tool: 'web_search', success: true, result: 'canada.ca/eta' }]],
    [
      completionCall,
      [
        {
          tool: 'attempt_completion',
          success: false,
          result: '',
          error: 'Rejected: this run has not successfully called send_user_message',
        },
      ],
    ],
  ]),
  roundResults: [{ tool: 'start_new_agent', success: true, result: 'Started agent a3f2b1' }],
  guidance: 'Correct the failed call.',
});

test('replays the model calls with their provider ids and arguments', () => {
  const [assistant] = nativeFeedback;
  assert.equal(assistant.role, 'assistant');
  assert.equal(assistant.content, '');
  assert.deepEqual(
    assistant.tool_calls?.map((call) => [call.id, call.function?.name, call.function?.arguments]),
    [
      ['call_grep', 'grep', '{"pattern":"passport"}'],
      ['sms-2-1', 'web_search', '{"query":"canada eta"}'],
      ['sms-2-2', 'attempt_completion', '{}'],
    ]
  );
});

test('answers each call with its own result, never a user turn', () => {
  const results = nativeFeedback.slice(1);
  assert.deepEqual(
    results.map((message) => [message.role, message.tool_call_id]),
    [
      ['tool', 'call_grep'],
      ['tool', 'sms-2-1'],
      ['tool', 'sms-2-2'],
    ]
  );
  assert.equal(results[0].content, '[grep] OK: Passport: G58219473');
  assert.equal(results[1].content, '[web_search] OK: canada.ca/eta');
});

test('puts round-level outcomes and guidance on the last result', () => {
  const last = String(nativeFeedback[nativeFeedback.length - 1].content);
  assert.ok(
    last.startsWith(
      '[attempt_completion] ERROR: Rejected: this run has not successfully called send_user_message'
    )
  );
  assert.ok(last.endsWith('[start_new_agent] OK: Started agent a3f2b1\nCorrect the failed call.'));
});

test('describes the runtime the model is actually running in', () => {
  // The overlay teaches surface-wide mechanics, while tool-local mechanics
  // live at the decision boundary in their schemas. Omitting these facts
  // produced real prod failures:
  //   - who is speaking → the model answered its own tool feedback (ack spam)
  //   - the send budget  → nothing bounded the fan-out
  //   - agent self-report → the model relayed agent progress itself
  //   - what costs money → "Let the agent work" bought $50 of budget
  //   - send-before-stop → a prompt inviting silence deadlocks the loop
  assert.match(SMS_SURFACE_OVERLAY, /only message in this conversation authored by a person/i);
  assert.match(SMS_SURFACE_OVERLAY, /owns its own channel to this same phone/i);
  assert.match(SMS_SURFACE_OVERLAY, /change the real world/i);
  assert.doesNotMatch(SMS_SURFACE_OVERLAY, /send nothing/i);

  const sendUserMessage = TOOL_SCHEMAS.find((tool) => tool.name === 'send_user_message');
  const attemptCompletion = TOOL_SCHEMAS.find((tool) => tool.name === 'attempt_completion');
  // Delivery mechanics live on the tool, not the overlay: the model reads them
  // at the moment it picks the tool.
  assert.match(sendUserMessage?.description ?? '', /cannot be undone/i);
  assert.match(
    attemptCompletion?.description ?? '',
    /rejects it unless this run has already successfully called send_user_message/i
  );

  // …and each of those claims must still be true of the runtime.
  assert.ok(
    HANDLER_SOURCE.includes('Rejected: this run has not successfully called send_user_message')
  );
});

test('stops nudging a model that keeps returning nothing', () => {
  // Observed on the SMS bench: "Chill" made the model return zero tool calls
  // every round. The loop nudged all ten times — ten LLM calls, ~40s — and
  // still ended in the fallback apology. Bounding the empty streak makes that
  // cost two calls, and the nudge now states the requirement instead of
  // restating the tool menu.
  assert.ok(HANDLER_SOURCE.includes('MAX_CONSECUTIVE_EMPTY_ROUNDS = 2'));
  assert.ok(HANDLER_SOURCE.includes('consecutiveEmptyRounds >= MAX_CONSECUTIVE_EMPTY_ROUNDS'));
  assert.ok(HANDLER_SOURCE.includes('staying silent is not an option this run'));
});
