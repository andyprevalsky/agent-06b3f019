/**
 * STATE MACHINE: optimistic USER message (a send to an existing agent)
 *
 *   [LOCAL local-user:<uuid>, Sending]
 *       |-- server row (POST reply, or the realtime INSERT / canonical reload
 *       |   carrying the same text) --> [SERVER row, Sending]
 *       |-- POST fails --> [DROPPED] (the sender restores the draft)
 *   [SERVER row, Sending]
 *       |-- a root LLM call starts after the row was persisted --> [DELIVERED]
 *
 * The agent loop polls new USER rows at the top of each step, right before
 * that step's LLM call, and the chat router answers with an LLM call too. Both
 * open their stream with llm_started_at_ms (StreamingBubble.llmStartedAtMs),
 * so a root stream that started after the row's timestamp is the step that
 * read it. Rows of the step already in flight (its tool results, sub-agent
 * work, the end of its own LLM call) do not count. The row keeps its
 * clientMessageId after the swap so its render key (and bubble) stay stable.
 */
import { useEffect, useRef } from 'react';

import type { Message } from '@/lib/api';

import type { StreamingBubble } from '../types';

const LOCAL_USER_MESSAGE_PREFIX = 'local-user:';

export function isLocalUserMessage(message: Pick<Message, 'message_id'>): boolean {
  return message.message_id.startsWith(LOCAL_USER_MESSAGE_PREFIX);
}

export function buildLocalUserMessage(text: string, now: Date = new Date()): Message {
  const messageId = `${LOCAL_USER_MESSAGE_PREFIX}${crypto.randomUUID()}`;
  return {
    message_id: messageId,
    timestamp: now.toISOString(),
    text,
    role: 'USER',
    metadata: { clientMessageId: messageId, clientDelivery: 'sending' },
  };
}

function isAwaitingPickup(message: Message): boolean {
  return message.role === 'USER' && message.metadata?.clientDelivery === 'sending';
}

/** The server row inherits the local row's client identity and delivery state. */
function withClientState(server: Message, client: Message): Message {
  const metadata = { ...server.metadata, clientMessageId: client.metadata?.clientMessageId };
  if (client.metadata?.clientDelivery === 'sending') metadata.clientDelivery = 'sending';
  return { ...server, metadata };
}

/** Clears Sending on server rows persisted before a root LLM call started. */
export function settlePickedUpUserMessages(
  messages: Message[],
  rootLlmStartedAtMs: number,
): Message[] {
  if (rootLlmStartedAtMs <= 0 || !messages.some(isAwaitingPickup)) return messages;
  let changed = false;
  const next = messages.map((message) => {
    if (!isAwaitingPickup(message) || isLocalUserMessage(message)) return message;
    if (!(Date.parse(message.timestamp) < rootLlmStartedAtMs)) return message;
    changed = true;
    const metadata = { ...message.metadata };
    delete metadata.clientDelivery;
    return { ...message, metadata };
  });
  return changed ? next : messages;
}

/** Latest root (non-sub-agent) LLM start among the live streams. */
export function latestRootLlmStart(bubbles: ReadonlyMap<string, StreamingBubble>): number {
  let latest = 0;
  for (const bubble of bubbles.values()) {
    if (!bubble.subAgentId && bubble.llmStartedAtMs !== undefined) {
      latest = Math.max(latest, bubble.llmStartedAtMs);
    }
  }
  return latest;
}

/**
 * Keeps the selected agent's highest root LLM start and settles every row
 * persisted before it, including server rows that swap in after the stream
 * began (the effect reruns on message changes and is a no-op otherwise).
 */
export function useUserMessagePickup(
  selectedAgentId: string | null,
  streamingBubbles: ReadonlyMap<string, StreamingBubble>,
  messages: Message[],
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>,
) {
  const watermarkRef = useRef({ agentId: selectedAgentId, startedAtMs: 0 });
  useEffect(() => {
    const watermark = watermarkRef.current;
    if (watermark.agentId !== selectedAgentId) {
      watermark.agentId = selectedAgentId;
      watermark.startedAtMs = 0;
    }
    watermark.startedAtMs = Math.max(watermark.startedAtMs, latestRootLlmStart(streamingBubbles));
    const startedAtMs = watermark.startedAtMs;
    if (startedAtMs > 0 && messages.some(isAwaitingPickup)) {
      setMessages((previous) => settlePickedUpUserMessages(previous, startedAtMs));
    }
  }, [selectedAgentId, streamingBubbles, messages, setMessages]);
}

/** A realtime USER INSERT replaces the first local row with the same text, in place. */
export function adoptServerUserMessage(previous: Message[], server: Message): Message[] | null {
  const index = previous.findIndex(
    (message) => isLocalUserMessage(message) && message.text === server.text,
  );
  if (index < 0) return null;
  return previous.map((message, i) => (i === index ? withClientState(server, message) : message));
}

/** The POST reply confirms the local row; the realtime INSERT may have adopted it already. */
export function confirmLocalUserMessage(
  previous: Message[],
  local: Message,
  server: Message,
): Message[] {
  const serverIndex = previous.findIndex((message) => message.message_id === server.message_id);
  const localIndex = previous.findIndex((message) => message.message_id === local.message_id);
  if (serverIndex >= 0) return previous.filter((_, i) => i !== localIndex);
  if (localIndex >= 0) {
    return previous.map((message, i) =>
      i === localIndex ? withClientState(server, message) : message,
    );
  }
  return [...previous, withClientState(server, local)];
}

export function dropLocalUserMessage(previous: Message[], localId: string): Message[] {
  const next = previous.filter((message) => message.message_id !== localId);
  return next.length === previous.length ? previous : next;
}

/**
 * A canonical reload keeps client identity on rows it already confirmed and
 * adopts local rows whose server copy it returns for the first time.
 */
export function carryClientUserMessages(previous: Message[], merged: Message[]): Message[] {
  const clientRows = previous.filter((message) => message.metadata?.clientMessageId);
  if (clientRows.length === 0) return merged;
  const previousIds = new Set(previous.map((message) => message.message_id));
  const confirmed = new Map(
    clientRows
      .filter((message) => !isLocalUserMessage(message))
      .map((message) => [message.message_id, message]),
  );
  const locals = clientRows.filter(isLocalUserMessage);
  const adopted = new Set<string>();
  const next = merged.map((message) => {
    const prior = confirmed.get(message.message_id);
    if (prior !== undefined) return prior === message ? message : withClientState(message, prior);
    if (message.role !== 'USER' || isLocalUserMessage(message)) return message;
    if (previousIds.has(message.message_id)) return message;
    const local = locals.find((row) => !adopted.has(row.message_id) && row.text === message.text);
    if (local === undefined) return message;
    adopted.add(local.message_id);
    return withClientState(message, local);
  });
  return adopted.size > 0 ? next.filter((message) => !adopted.has(message.message_id)) : next;
}
