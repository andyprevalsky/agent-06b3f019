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

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SMS_SURFACE_OVERLAY } from '../../providers/smsSupervisor/contextBuilder';
import {
  MAX_USER_MESSAGES_PER_RUN,
  SEND_BUDGET_EXHAUSTED_ERROR,
  buildToolFeedbackMessages,
} from '../../providers/smsSupervisor/environmentMessages';

const HANDLER_SOURCE = readFileSync(
  join(__dirname, '../../providers/smsSupervisor/supervisorHandler.ts'),
  'utf8'
);

describe('buildToolFeedbackMessages', () => {
  const feedback = buildToolFeedbackMessages({
    round: 3,
    assistantPayload: '{"reasoning":"r","tool_calls":[]}',
    toolResultSummary: 'Tool results:\n[grep] OK: 2 hits',
    guidance: 'Incorporate these results.',
  });

  it('never emits a user turn', () => {
    expect(feedback.map((message) => message.role)).toEqual(['assistant', 'tool']);
    expect(feedback.some((message) => message.role === 'user')).toBe(false);
  });

  it('pairs the tool result with the assistant turn that requested it', () => {
    const [assistant, tool] = feedback;
    const callId = assistant.tool_calls?.[0]?.id;
    expect(callId).toBe('sms-tool-results-3');
    expect(tool.tool_call_id).toBe(callId);
  });

  it('carries both the results and the guidance to the model', () => {
    expect(feedback[1].content).toContain('[grep] OK: 2 hits');
    expect(feedback[1].content).toContain('Incorporate these results.');
  });

  it('omits the empty results header when a round produced no tool calls', () => {
    const empty = buildToolFeedbackMessages({
      round: 0,
      assistantPayload: '{}',
      toolResultSummary: '',
      guidance: 'That response contained no tool calls.',
    });
    expect(empty[1].content).toBe('That response contained no tool calls.');
  });
});

describe('supervisor loop control plane', () => {
  it('never appends a synthetic user turn', () => {
    // The only legitimate user turn is the real inbound SMS, built once from
    // `inboundContent`. Any other `role: 'user'` in the loop is control text
    // wearing the human's voice — the exact defect this guards.
    const userTurns = HANDLER_SOURCE.match(/role: 'user'/g) ?? [];
    expect(userTurns).toHaveLength(1);
    expect(HANDLER_SOURCE).toContain("{ role: 'user', content: inboundContent }");
  });

  it('routes every loop nudge through buildToolFeedbackMessages', () => {
    expect(HANDLER_SOURCE).not.toMatch(/messages\.push\(\{\s*role: 'user'/);
    const feedbackCalls = HANDLER_SOURCE.match(/environment\.buildToolFeedbackMessages\(/g) ?? [];
    expect(feedbackCalls.length).toBeGreaterThanOrEqual(3);
  });

  it('describes the runtime the model is actually running in', () => {
    // The overlay teaches mechanics, not a rule list — the model infers conduct
    // from how the surface works. Each fact below is one the loop enforces in
    // code, and omitting it produced a real prod failure:
    //   - who is speaking → the model answered its own tool feedback (ack spam)
    //   - the send budget  → nothing bounded the fan-out
    //   - agent self-report → the model relayed agent progress itself
    //   - what costs money → "Let the agent work" bought $50 of budget
    //   - send-before-stop → a prompt inviting silence deadlocks the loop
    expect(SMS_SURFACE_OVERLAY).toMatch(/only message in this conversation authored by a person/i);
    expect(SMS_SURFACE_OVERLAY).toMatch(/at most two sends per run/i);
    expect(SMS_SURFACE_OVERLAY).toMatch(/owns its own channel to this same phone/i);
    expect(SMS_SURFACE_OVERLAY).toMatch(/change the real world/i);
    expect(SMS_SURFACE_OVERLAY).toMatch(/rejected until at least one send has succeeded/i);
    expect(SMS_SURFACE_OVERLAY).not.toMatch(/send nothing/i);

    // …and each of those claims must still be true of the runtime.
    expect(HANDLER_SOURCE).toContain(
      'Rejected: this run has not successfully called send_user_message'
    );
    expect(MAX_USER_MESSAGES_PER_RUN).toBe(2);
  });

  it('stops nudging a model that keeps returning nothing', () => {
    // Observed on the SMS bench: "Chill" made the model return zero tool calls
    // every round. The loop nudged all ten times — ten LLM calls, ~40s — and
    // still ended in the fallback apology. Bounding the empty streak makes that
    // cost two calls, and the nudge now states the requirement instead of
    // restating the tool menu.
    expect(HANDLER_SOURCE).toContain('MAX_CONSECUTIVE_EMPTY_ROUNDS = 2');
    expect(HANDLER_SOURCE).toContain('consecutiveEmptyRounds >= MAX_CONSECUTIVE_EMPTY_ROUNDS');
    expect(HANDLER_SOURCE).toContain('staying silent is not an option this run');
  });

  it('enforces the per-run send budget at the delivery boundary', () => {
    expect(HANDLER_SOURCE).toContain('environment.MAX_USER_MESSAGES_PER_RUN');
    expect(HANDLER_SOURCE).toContain('environment.SEND_BUDGET_EXHAUSTED_ERROR');
    expect(MAX_USER_MESSAGES_PER_RUN).toBeLessThan(4);
    expect(SEND_BUDGET_EXHAUSTED_ERROR).toContain('attempt_completion');
  });
});
