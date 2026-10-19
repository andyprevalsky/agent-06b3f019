/**
 * Codex-format agent message bodies (agent messages and completions):
 *
 *   Message Type: FINAL_ANSWER | FAILED | MESSAGE | NEW_TASK
 *   Task name: …
 *   Sender: …
 *   Payload:
 *   <payload…>
 *
 * The UI shows only the payload; status and addresses come from metadata.
 */

const PAYLOAD_MARKER = /^Payload:[ \t]*\n?/m;

/** The payload of a Codex body; plain text passes through unchanged. */
export function codexPayload(text: string): string {
  if (!/^\s*Message Type:/.test(text)) return text.trim();
  const match = PAYLOAD_MARKER.exec(text);
  return match ? text.slice(match.index + match[0].length).trim() : '';
}

const STATUS_BY_TYPE: Record<string, string> = {
  FINAL_ANSWER: 'completed',
  FAILED: 'failed',
};

/** Completion status: metadata.status, else derived from messageType. */
export function completionStatus(metadata: Record<string, unknown> | undefined): string | null {
  const status = metadata?.status;
  if (typeof status === 'string' && status) return status;
  return STATUS_BY_TYPE[String(metadata?.messageType ?? '')] ?? null;
}
