import type { PostMessageBody } from './types';

/** Stamp credential provenance at the authenticated write boundary, never from text. */
export function withCredentialProvenance(
  body: PostMessageBody,
  isInternal: boolean
): PostMessageBody {
  const metadata = body.metadata;
  if (!metadata) return body;
  const clean = { ...metadata };
  delete clean.browserCredentialContext;
  const ref = clean.credential_ref;
  const nonempty = (value: unknown): value is string =>
    typeof value === 'string' && value.trim().length > 0;
  const credential =
    isInternal &&
    body.role === 'USER' &&
    nonempty(clean.subAgentId) &&
    ref !== null &&
    typeof ref === 'object' &&
    !Array.isArray(ref) &&
    nonempty((ref as Record<string, unknown>).kind) &&
    nonempty((ref as Record<string, unknown>).id);
  return {
    ...body,
    metadata: { ...clean, ...(credential ? { browserCredentialContext: true } : {}) },
  };
}

/** USER rows written by agents rather than people (metadata flags, never text). */
export function isAgentAuthoredRow(metadata: PostMessageBody['metadata']): boolean {
  return (
    metadata?.agentNotification === true ||
    metadata?.agentMessage === true ||
    metadata?.environmentContext === true ||
    metadata?.browserCredentialContext === true
  );
}
