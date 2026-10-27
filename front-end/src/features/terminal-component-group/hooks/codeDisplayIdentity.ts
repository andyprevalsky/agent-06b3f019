import type { Message } from '@/lib/api/types';

/** Called after conversation filtering: replay/dual-publish carries the same canonical id. */
export function dedupeCodeDisplays(messages: Message[]): Message[] {
  const byIdentity = new Map<string, Message>();
  const identities = new Map<Message, string>();
  for (const message of messages) {
    const display = message.metadata?.display as
      { canonical_id?: unknown; conversation?: unknown } | undefined;
    if (typeof display?.canonical_id !== 'string' || !display.canonical_id) continue;
    const identity = `${display.canonical_id}:${message.file_pointer?.storage_path ?? ''}`;
    identities.set(message, identity);
    const previous = byIdentity.get(identity);
    if (!previous || display.conversation === 'parent') byIdentity.set(identity, message);
  }
  const seen = new Set<string>();
  return messages.filter((message) => {
    const identity = identities.get(message);
    if (!identity) return true;
    if (seen.has(identity) || byIdentity.get(identity) !== message) return false;
    seen.add(identity);
    return true;
  });
}
