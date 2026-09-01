/**
 * Chat startup context
 *
 * System context:
 *
 *   startInitialChatContext ──> ordered messages ──> project checkpoints
 *                            ──> auto-compact if over budget ──> Router ──┬─ direct_answer
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
import { ensureChatContextWithinBudget } from './chatCompaction';
import { projectModelContextAfterCompaction } from './contextCompaction';

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
  ensureWithinBudget?: (params: {
    agentId: string;
    requestedModel: string;
    rawMessages: ChatMessage[];
  }) => Promise<ChatMessage[]>;
}

export interface InitialChatContext {
  messages: Promise<ChatMessage[]>;
}

interface StartInitialChatContextConfig {
  agentId: string;
  requestedModel: string;
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
  ensureWithinBudget: ensureChatContextWithinBudget,
};

export async function loadChatModelMessages(
  config: StartInitialChatContextConfig,
  dependencies: InitialChatContextDependencies = defaultDependencies
): Promise<ChatMessage[]> {
  const rawMessages = mapChatDatabaseMessages(await dependencies.findMessages(config.agentId));
  const ensureWithinBudget = dependencies.ensureWithinBudget;
  if (!ensureWithinBudget) {
    return projectModelContextAfterCompaction(rawMessages);
  }
  return ensureWithinBudget({
    agentId: config.agentId,
    requestedModel: config.requestedModel,
    rawMessages,
  });
}

export function startInitialChatContext(
  config: StartInitialChatContextConfig,
  dependencies: InitialChatContextDependencies = defaultDependencies
): InitialChatContext {
  const messages = invoke(() => loadChatModelMessages(config, dependencies));

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
