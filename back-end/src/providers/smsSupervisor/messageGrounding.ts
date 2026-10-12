/**
 * Exact-body helpers for send_user_message.
 *
 * Whether a message's claims are grounded is the model's call, stated once in
 * the SMS overlay ("# How to Respond"). The harness no longer classifies
 * message text with regexes: those rejected honest questions and still missed
 * paraphrased claims (2026-10-12 eTA benchmark: eight plain questions blocked,
 * then the fallback apology).
 */

export function normalizeSmsClaimText(text: string): string {
  return text.replace(/[\u2018\u2019\u201B]/g, "'").replace(/[\u201C\u201D]/g, '"');
}

export function sameSmsBody(left: string, right: string): boolean {
  return normalizeSmsClaimText(left).trim() === normalizeSmsClaimText(right).trim();
}

/** A send needs a non-empty string body; content is the model's responsibility. */
export function resolveSendUserMessage(
  message: unknown
): { ok: true; text: string } | { ok: false; error: string } {
  if (typeof message !== 'string' || message.trim() === '') {
    return { ok: false, error: 'message must be a non-empty string' };
  }
  return { ok: true, text: message };
}
