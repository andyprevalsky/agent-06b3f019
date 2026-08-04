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
  MAX_USER_MESSAGES_PER_RUN,
  SEND_BUDGET_EXHAUSTED_ERROR,
  buildToolFeedbackMessages,
} from '../../providers/smsSupervisor/environmentMessages';
import { TOOL_SCHEMAS } from '../../providers/smsSupervisor/supervisorTools.schemas';

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

test('routes every loop nudge through buildToolFeedbackMessages', () => {
  assert.doesNotMatch(HANDLER_SOURCE, /messages\.push\(\{\s*role: 'user'/);
  const feedbackCalls = HANDLER_SOURCE.match(/environment\.buildToolFeedbackMessages\(/g) ?? [];
  assert.ok(feedbackCalls.length >= 3);
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
  assert.match(sendUserMessage?.description ?? '', /at most two successful sends per run/i);
  assert.match(
    attemptCompletion?.description ?? '',
    /rejects it unless this run has already successfully called send_user_message/i
  );

  // …and each of those claims must still be true of the runtime.
  assert.ok(
    HANDLER_SOURCE.includes('Rejected: this run has not successfully called send_user_message')
  );
  assert.equal(MAX_USER_MESSAGES_PER_RUN, 2);
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

test('enforces the per-run send budget at the delivery boundary', () => {
  assert.ok(HANDLER_SOURCE.includes('environment.MAX_USER_MESSAGES_PER_RUN'));
  assert.ok(HANDLER_SOURCE.includes('environment.SEND_BUDGET_EXHAUSTED_ERROR'));
  assert.ok(MAX_USER_MESSAGES_PER_RUN < 4);
  assert.ok(SEND_BUDGET_EXHAUSTED_ERROR.includes('attempt_completion'));
});
