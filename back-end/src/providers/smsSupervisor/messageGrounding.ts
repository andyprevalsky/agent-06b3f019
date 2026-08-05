/**
 * Ground send_user_message claims against side effects this SMS supervisor run
 * actually queued/committed. Prevents the model from texting "agent started" /
 * "order submitted" when it never called start_new_agent (prod 2026-08-04
 * Blue Bottle incident: 10 rounds of send_user_message only).
 */

export interface SmsRunSideEffectEvidence {
  /** True once start_new_agent was queued or successfully committed this run. */
  startedAgent: boolean;
  /** True once kill_agent was queued or successfully committed this run. */
  killedAgent: boolean;
}

/** Agent-lifecycle claims that require a matching write tool this run. */
const AGENT_START_CLAIM =
  /\b(?:agent(?:\s+is)?\s+started|started\s+(?:a\s+|an\s+|the\s+)?(?:fresh\s+)?agent|starting\s+a\s+fresh|fresh\s+(?:\w+\s+){0,4}agent\s+is\s+(?:live|running|on\s+it)|spawned\s+(?:a\s+|an\s+)?agent|agent\s+is\s+(?:live|running))\b/i;

const AGENT_KILL_CLAIM =
  /\b(?:kill(?:ing|ed)\s+(?:old\s+)?(?:\w+\s+){0,4}agents?|deleted\s+(?:the\s+)?old\s+(?:\w+\s+){0,4}agents?)\b/i;

/**
 * Order/purchase progress that the SMS supervisor cannot know without agent
 * completion evidence in the state block — claiming it from chat alone is
 * always ungrounded in this surface.
 */
const ORDER_PROGRESS_CLAIM =
  /\b(?:placing\s+now|order\s+submitted|order\s+(?:is\s+)?confirmed|(?:placed|submitted)\s+(?:the\s+|your\s+)?(?:order|blue\s*bottle)|waiting\s+on\s+confirmation|confirmation\s*[#:]?\s*[a-z0-9-]{4,})\b/i;

export function emptySmsRunSideEffectEvidence(): SmsRunSideEffectEvidence {
  return { startedAgent: false, killedAgent: false };
}

export function absorbPendingOpKind(
  evidence: SmsRunSideEffectEvidence,
  kind: string
): SmsRunSideEffectEvidence {
  if (kind === 'start_new_agent') {
    return { ...evidence, startedAgent: true };
  }
  if (kind === 'kill_agent') {
    return { ...evidence, killedAgent: true };
  }
  return evidence;
}

/**
 * Returns an error string when `message` claims side effects this run did not
 * perform; null when the message is allowed to send.
 */
export function resolveSendUserMessage(
  message: unknown,
  evidence: SmsRunSideEffectEvidence
): { ok: true; text: string } | { ok: false; error: string } {
  if (typeof message !== 'string' || message.trim() === '') {
    return { ok: false, error: 'message must be a non-empty string' };
  }
  const groundingError = ungroundedSendUserMessageError(message, evidence);
  if (groundingError !== null) {
    return { ok: false, error: groundingError };
  }
  return { ok: true, text: message };
}

export function ungroundedSendUserMessageError(
  message: string,
  evidence: SmsRunSideEffectEvidence
): string | null {
  const text = message.trim();
  if (text === '') {
    return null;
  }

  if (ORDER_PROGRESS_CLAIM.test(text)) {
    return (
      'Rejected: message claims order/placement progress that this SMS run has no ' +
      'evidence for. Only report confirmations, totals, or "placed/submitted" after ' +
      'an agent completion appears in the current state block. Use start_new_agent ' +
      'for the work, then tell the user the agent is working — never invent progress.'
    );
  }

  if (AGENT_START_CLAIM.test(text) && !evidence.startedAgent) {
    return (
      'Rejected: message claims an agent was started, but this run has not called ' +
      'start_new_agent. Call start_new_agent first (there is no spawn_agent tool on ' +
      'the SMS surface), then send a message grounded in that tool result.'
    );
  }

  if (AGENT_KILL_CLAIM.test(text) && !evidence.killedAgent) {
    return (
      'Rejected: message claims agents were killed/deleted, but this run has not ' +
      'called kill_agent. Call kill_agent first, then report the grounded result.'
    );
  }

  return null;
}

/** Acquisition verbs that mean "do the buy", not "tell me what to buy". */
const PURCHASE_ACTION =
  /\b(?:get\s+me|buy(?:\s+me)?|purchase(?:\s+me)?|order(?:\s+me)?|grab\s+me)\b/i;

/** Merchant / commerce venue signals paired with a purchase action. */
const PURCHASE_VENUE =
  /\b(?:amazon|from\s+amazon|on\s+amazon|walmart|target|instacart|doordash|uber\s*eats|blue\s*bottle)\b/i;

/**
 * True when the inbound SMS is a clear "obtain this for me" request (bias-to-
 * action purchase), not a pure research question.
 */
export function isClearPurchaseIntent(userText: string): boolean {
  const text = userText.trim();
  if (text === '') {
    return false;
  }
  return PURCHASE_ACTION.test(text) && PURCHASE_VENUE.test(text);
}

/**
 * Reject attempt_completion when the user asked for a purchase/get-me and this
 * run never called start_new_agent. Prevents finishing after a web_search
 * recommendation alone (observed with cerebras glm on "get me … from amazon").
 */
export function purchaseIntentCompletionError(
  userText: string,
  evidence: SmsRunSideEffectEvidence
): string | null {
  if (!isClearPurchaseIntent(userText)) {
    return null;
  }
  if (evidence.startedAgent) {
    return null;
  }
  return (
    'Rejected: the user asked you to obtain/purchase this, not just recommend. ' +
    'Call start_new_agent with a purchase goal before attempt_completion. A ' +
    'web_search recommendation alone does not complete a purchase request.'
  );
}
