import { useMemo, useRef } from 'react';
import type { Message } from '../hooks';

const GENERAL_PURPOSE_AGENT_TOOLS = new Set([
  'spawn_general_purpose_agent',
  'spawn_general_purpose_agent_for_each',
  'spawn_sub_agent',
]);

// ─── Merge sub-agent tree messages by emission group ─────────────────────

function baseToolCallId(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const colonIndex = value.indexOf(':');
  return colonIndex === -1 ? value : value.slice(0, colonIndex);
}

function isSpawnTree(m: Message): boolean {
  return (
    !!m.metadata?.toolName &&
    GENERAL_PURPOSE_AGENT_TOOLS.has(m.metadata.toolName) &&
    Array.isArray(m.metadata?.subAgentIds) &&
    (m.metadata.subAgentIds as string[]).length > 0 &&
    !!m.metadata?.busId
  );
}

export function isDirectSpawnChildProgress(m: Message): boolean {
  return (
    m.role === 'TOOL' &&
    m.metadata?.toolName === 'spawn_general_purpose_agent' &&
    typeof m.metadata?.subAgentId === 'string' &&
    !Array.isArray(m.metadata?.subAgentIds) &&
    !m.metadata?.busId
  );
}

function isForEachTerminal(m: Message): boolean {
  return (
    m.metadata?.toolName === 'spawn_general_purpose_agent_for_each' &&
    (m.metadata?.toolStatus === 'FINISHED' || m.metadata?.toolStatus === 'ERROR')
  );
}

/**
 * The DAG emits an IN_PROGRESS `spawn_general_purpose_agent_for_each` row under
 * the parent toolCallId BEFORE any child is spawned — the "Spawning agent
 * cluster" placeholder (rendered as "Spawning general-purpose agents..."). Its
 * children fan out under SUFFIXED toolCallIds (`parent:idx`), so unlike the
 * single-spawn path they never dedup-collapse with this parent row, and the
 * terminal aggregate row only arrives once every child finishes. Left alone the
 * placeholder lingers as a stray line above the live child tree for the whole
 * run. Once children exist, fold it away — the grouped child tree (or, at the
 * end, the merged terminal aggregate) is the single source of truth.
 */
function isForEachPlaceholder(m: Message): boolean {
  return (
    m.metadata?.toolName === 'spawn_general_purpose_agent_for_each' &&
    m.metadata?.toolStatus === 'IN_PROGRESS' &&
    !Array.isArray(m.metadata?.subAgentIds)
  );
}

function normalizedSpawnGroupId(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value.startsWith('for_each:') ? value.slice('for_each:'.length) : value;
}

/** Group ids that already have live for_each child spawn-tree rows. */
function collectForEachChildGroupIds(messages: Message[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    if (!isSpawnTree(m)) continue;
    const spawnGroupId = normalizedSpawnGroupId(m.metadata?.spawnGroupId);
    if (spawnGroupId) ids.add(spawnGroupId);
    const toolCallId = m.metadata?.toolCallId;
    if (typeof toolCallId !== 'string') continue;
    const base = baseToolCallId(toolCallId);
    if (base) ids.add(base);
  }
  return ids;
}

interface SpawnGroup {
  firstIndex: number;
  ids: string[];
  knownIds: Set<string>;
  firstMsg: Message;
}

interface ForEachTerminalGroup {
  messageIndex: number;
  message: Message;
  ids: string[];
  knownIds: Set<string>;
  busId?: string;
  spawnGroupId?: string;
}

function collectForEachTerminalGroups(messages: Message[]): Map<string, ForEachTerminalGroup> {
  const groups = new Map<string, ForEachTerminalGroup>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!isForEachTerminal(msg)) continue;
    const callId = baseToolCallId(msg.metadata?.toolCallId);
    if (!callId) continue;
    const ids = Array.isArray(msg.metadata?.subAgentIds)
      ? [...(msg.metadata.subAgentIds as string[])]
      : [];
    groups.set(callId, {
      messageIndex: i,
      message: msg,
      ids,
      knownIds: new Set(ids),
      busId: msg.metadata?.busId as string | undefined,
      spawnGroupId: msg.metadata?.spawnGroupId as string | undefined,
    });
  }

  for (const msg of messages) {
    if (!isSpawnTree(msg)) continue;
    const childBaseCallId = baseToolCallId(msg.metadata?.toolCallId);
    if (!childBaseCallId) continue;
    const terminal = groups.get(childBaseCallId);
    if (!terminal) continue;
    terminal.busId = (msg.metadata?.busId as string | undefined) ?? terminal.busId;
    terminal.spawnGroupId =
      (msg.metadata?.spawnGroupId as string | undefined) ?? terminal.spawnGroupId;
    for (const id of msg.metadata!.subAgentIds as string[]) {
      if (!terminal.knownIds.has(id)) {
        terminal.ids.push(id);
        terminal.knownIds.add(id);
      }
    }
  }

  return groups;
}

function spawnGroupKey(msg: Message): string {
  const spawnGroupId = normalizedSpawnGroupId(msg.metadata!.spawnGroupId);
  if (spawnGroupId) return spawnGroupId;
  const toolCallId = msg.metadata?.toolCallId;
  const base = baseToolCallId(toolCallId);
  if (base) return base;
  return msg.metadata!.busId as string;
}

function synthesizeLegacySpawnTreeMessages(messages: Message[], rootAgentId?: string): Message[] {
  if (!rootAgentId) return messages;
  return messages.map((msg) => {
    if (!isDirectSpawnChildProgress(msg)) return msg;
    const childId = msg.metadata?.subAgentId;
    if (typeof childId !== 'string' || childId.length === 0) return msg;
    const toolCallId = msg.metadata?.toolCallId;
    const base = baseToolCallId(toolCallId);
    const legacySpawnGroupId =
      typeof msg.metadata?.spawnGroupId === 'string'
        ? msg.metadata.spawnGroupId
        : (base ?? rootAgentId);
    return {
      ...msg,
      metadata: {
        ...msg.metadata,
        busId: rootAgentId,
        subAgentIds: [childId],
        spawnGroupId: legacySpawnGroupId,
      },
    };
  });
}

function groupSpawnTrees(messages: Message[]): {
  groupsByKey: Map<string, SpawnGroup>;
  skipIndices: Set<number>;
} {
  const terminalGroups = collectForEachTerminalGroups(messages);
  const groupsByKey = new Map<string, SpawnGroup>();
  const skipIndices = new Set<number>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!isSpawnTree(msg)) continue;
    const childBaseCallId = baseToolCallId(msg.metadata?.toolCallId);
    const key = spawnGroupKey(msg);
    if (
      !isForEachTerminal(msg) &&
      childBaseCallId !== null &&
      terminalGroups.has(childBaseCallId)
    ) {
      skipIndices.add(i);
      continue;
    }

    const group = groupsByKey.get(key);
    if (group) {
      for (const id of msg.metadata!.subAgentIds as string[]) {
        if (!group.knownIds.has(id)) {
          group.ids.push(id);
          group.knownIds.add(id);
        }
      }
      skipIndices.add(i);
    } else {
      groupsByKey.set(key, {
        firstIndex: i,
        ids: [...(msg.metadata!.subAgentIds as string[])],
        knownIds: new Set(msg.metadata!.subAgentIds as string[]),
        firstMsg: msg,
      });
    }
  }
  return { groupsByKey, skipIndices };
}

function mergeForEachTerminalMessage(
  msg: Message,
  terminalGroups: Map<string, ForEachTerminalGroup>,
): Message {
  const callId = baseToolCallId(msg.metadata?.toolCallId);
  const terminal = callId ? terminalGroups.get(callId) : undefined;
  if (!terminal?.busId || terminal.ids.length === 0) return msg;
  return {
    ...msg,
    metadata: {
      ...msg.metadata,
      busId: terminal.busId,
      spawnGroupId: terminal.spawnGroupId,
      subAgentIds: terminal.ids,
      forEachAggregate: true,
    },
  };
}

function buildMergedMessages(
  messages: Message[],
  groupsByKey: Map<string, SpawnGroup>,
  skipIndices: Set<number>,
  prevCache: Map<string, Message>,
): { result: Message[]; newCache: Map<string, Message> } {
  const newCache = new Map<string, Message>();
  const result: Message[] = [];
  const terminalGroups = collectForEachTerminalGroups(messages);
  const forEachChildGroupIds = collectForEachChildGroupIds(messages);

  for (let i = 0; i < messages.length; i++) {
    if (skipIndices.has(i)) continue;
    let msg = messages[i];

    // Drop the for_each "Spawning..." placeholder once its children exist —
    // the child tree (grouped below) becomes the single visible row.
    if (isForEachPlaceholder(msg)) {
      const base = baseToolCallId(msg.metadata?.toolCallId);
      if (base && forEachChildGroupIds.has(base)) continue;
    }

    if (isForEachTerminal(msg)) {
      msg = mergeForEachTerminalMessage(msg, terminalGroups);
    }

    if (!isSpawnTree(msg)) {
      result.push(msg);
      continue;
    }

    const key = spawnGroupKey(msg);
    const group = groupsByKey.get(key) ?? {
      firstIndex: i,
      ids: msg.metadata!.subAgentIds as string[],
      firstMsg: msg,
    };
    const idsKey = group.ids.join(',');

    const merged: Message = {
      ...msg,
      metadata: { ...msg.metadata, subAgentIds: group.ids },
    };
    const cached = prevCache.get(key);
    const cacheMatchesCurrentMessage =
      cached &&
      cached.text === merged.text &&
      cached.role === merged.role &&
      cached.metadata?.toolStatus === merged.metadata?.toolStatus &&
      cached.metadata?.toolCallId === merged.metadata?.toolCallId &&
      cached.metadata?.busId === merged.metadata?.busId &&
      cached.metadata?.spawnGroupId === merged.metadata?.spawnGroupId &&
      cached.metadata?.forEachAggregate === merged.metadata?.forEachAggregate &&
      (cached.metadata?.subAgentIds as string[])?.join(',') === idsKey;

    if (cacheMatchesCurrentMessage) {
      result.push(cached);
      newCache.set(key, cached);
    } else {
      result.push(merged);
      newCache.set(key, merged);
    }
  }

  return { result, newCache };
}

export function useSubAgentTreeMerge(messages: Message[], rootAgentId?: string): Message[] {
  const prevMergedRef = useRef<Map<string, Message>>(new Map());
  const cacheOwnerRef = useRef(rootAgentId);
  if (cacheOwnerRef.current !== rootAgentId) {
    prevMergedRef.current = new Map();
    cacheOwnerRef.current = rootAgentId;
  }

  return useMemo(() => {
    const { result, newCache } = mergeSubAgentTreeMessages(
      messages,
      prevMergedRef.current,
      rootAgentId,
    );
    prevMergedRef.current = newCache;
    return result;
  }, [messages, rootAgentId]);
}

export function mergeSubAgentTreeMessages(
  messages: Message[],
  prevCache: Map<string, Message> = new Map(),
  rootAgentId?: string,
): { result: Message[]; newCache: Map<string, Message> } {
  const repairedMessages = synthesizeLegacySpawnTreeMessages(messages, rootAgentId);
  const { groupsByKey, skipIndices } = groupSpawnTrees(repairedMessages);
  return buildMergedMessages(repairedMessages, groupsByKey, skipIndices, prevCache);
}
