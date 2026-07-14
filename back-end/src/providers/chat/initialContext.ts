/**
 * Chat startup context
 *
 * System context:
 *
 *   startInitialChatContext ──> ordered messages ──> Router ──┬─ direct_answer
 *                                                            │    └─ same array ─> Generator
 *                                                            └─ other action
 *                                                                 └─ refresh ───> Generator
 *
 * State:
 *   STARTED -> MESSAGES_PENDING
 *     messages rejected  -> router blocked / chat failed
 *     messages fulfilled -> Router and speculative Generator may run
 *     direct_answer       -> reuse exact initial message snapshot
 *     other action        -> refresh ordered messages after branch side effects
 *     escalation branch   -> exit without any credential lookup
 */

import { prisma } from '../database';

export interface ChatDatabaseMessage {
  role: string;
  text: string;
  filePointer: unknown;
  metadata: unknown;
}

export interface ChatMessage {
  role: 'USER' | 'ASSISTANT' | 'TOOL' | 'SYSTEM';
  text: string;
  filePointer?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

interface InitialChatContextDependencies {
  findMessages: (agentId: string) => Promise<ChatDatabaseMessage[]>;
}

export interface InitialChatContext {
  messages: Promise<ChatMessage[]>;
}

interface ResolveGeneratorMessagesOptions {
  action: string;
  initialMessages: ChatMessage[];
  refreshMessages: () => Promise<ChatMessage[]>;
}

const defaultDependencies: InitialChatContextDependencies = {
  findMessages: (agentId) =>
    prisma.message.findMany({
      where: { agentId },
      orderBy: { timestamp: 'asc' },
    }),
};

export function startInitialChatContext(
  config: { agentId: string },
  dependencies: InitialChatContextDependencies = defaultDependencies
): InitialChatContext {
  const messages = invoke(() => dependencies.findMessages(config.agentId)).then(
    mapChatDatabaseMessages
  );

  return { messages };
}

export function mapChatDatabaseMessages(dbMessages: ChatDatabaseMessage[]): ChatMessage[] {
  return dbMessages.map((message) => ({
    role: message.role as ChatMessage['role'],
    text: message.text,
    filePointer: message.filePointer as Record<string, unknown> | undefined,
    metadata: message.metadata as Record<string, unknown> | undefined,
  }));
}

export async function resolveGeneratorMessages(
  options: ResolveGeneratorMessagesOptions
): Promise<ChatMessage[]> {
  if (options.action === 'direct_answer') return options.initialMessages;
  return options.refreshMessages();
}

function invoke<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return operation();
  } catch (error) {
    return Promise.reject(error);
  }
}
