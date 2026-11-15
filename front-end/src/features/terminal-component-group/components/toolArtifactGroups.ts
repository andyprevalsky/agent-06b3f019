/** Project persisted tool artifacts into their owning result without changing the transcript. */
import type { Message } from '../hooks';
import { isClaudeCodeChipAnchor } from './useMessageFiltering';

export function isToolArtifact(message: Message): boolean {
  return Boolean(
    message.role === 'ASSISTANT' &&
    message.file_pointer &&
    message.metadata?.artifactOnly === true &&
    typeof message.metadata.sourceToolCallId === 'string' &&
    message.metadata.sourceToolCallId.length > 0 &&
    !message.metadata.display &&
    !message.metadata.inlineView &&
    !message.metadata.isUserAttentionMessage &&
    !message.metadata.requestUserAuthentication &&
    !message.metadata.requestUserApproval &&
    !message.metadata.requestUserSignup,
  );
}
interface Owner {
  message: Message;
  run: number;
  ambiguous?: boolean;
}
function terminal(message: Message) {
  return message.metadata?.toolStatus === 'FINISHED' || message.metadata?.toolStatus === 'ERROR';
}
function collectOwners(messages: Message[]) {
  const calls = new Map<string, Map<number, Owner>>();
  for (const message of messages) {
    const meta = message.metadata;
    if (
      message.role !== 'TOOL' ||
      typeof meta?.toolCallId !== 'string' ||
      (meta.subAgentId && !isClaudeCodeChipAnchor(message))
    )
      continue;
    const run = typeof meta.backgroundRun === 'number' ? meta.backgroundRun : 1;
    const runs = calls.get(meta.toolCallId) ?? new Map<number, Owner>();
    const previous = runs.get(run);
    if (!previous) runs.set(run, { message, run });
    else {
      // Prefer the actual browser/code result over its generic spawn wrapper;
      // a late progress event cannot replace a terminal result.
      const specialised =
        meta.toolName === 'spawn_browser_agent' || meta.toolName === 'spawn_claude_code_agent';
      const previousSpecialised = ['spawn_browser_agent', 'spawn_claude_code_agent'].includes(
        String(previous.message.metadata?.toolName),
      );
      const previousTool = previous.message.metadata?.toolName;
      if (
        previousTool !== meta.toolName &&
        previousTool !== 'spawn_agent' &&
        meta.toolName !== 'spawn_agent'
      )
        previous.ambiguous = true;
      if (
        (!previousSpecialised || specialised) &&
        (!terminal(previous.message) || terminal(message))
      )
        previous.message = message;
    }
    calls.set(meta.toolCallId, runs);
  }
  return calls;
}
export function groupToolArtifacts(messages: Message[]) {
  const calls = collectOwners(messages);
  const byOwner = new Map<string, Message[]>();
  const seen = new Map<string, Set<string>>();
  const visibleMessages = messages.filter((message) => {
    if (!isToolArtifact(message)) return true;
    const runs = calls.get(message.metadata!.sourceToolCallId as string);
    const explicitRun = message.metadata?.backgroundRun;
    // Historical artifact rows have no backgroundRun. A reused call is ambiguous:
    // retain an independent collapsed disclosure instead of assigning to the wrong run.
    const owner =
      typeof explicitRun === 'number'
        ? runs?.get(explicitRun)
        : runs?.size === 1
          ? runs.values().next().value
          : undefined;
    // Missing owners remain a collapsed file disclosure, never a lost file.
    if (!owner || owner.ambiguous) return true;
    const id = owner.message.message_id;
    const identity = message.file_pointer!.storage_path;
    const keys = seen.get(id) ?? new Set<string>();
    if (!keys.has(identity)) {
      const artifacts = byOwner.get(id) ?? [];
      artifacts.push(message);
      byOwner.set(id, artifacts);
      keys.add(identity);
      seen.set(id, keys);
    }
    return false;
  });
  return { visibleMessages, byOwner };
}
