/**
 * Chat startup context
 *
 * System context:
 *
 *   startInitialChatContext ──> ordered messages ──> project checkpoints
 *                            ──> auto-compact if over budget ──> Router ──┬─ direct_answer
 *                                                            │    └─ same array ─> Generator
 *                                                            └─ web_search round
 *                                                                 └─ reload ────> Router again
 *                                                                                └─> Generator
 *
 * State:
 *   STARTED -> MESSAGES_PENDING
 *     messages rejected  -> router blocked / chat failed
 *     messages fulfilled -> Router and speculative Generator may run
 *     direct_answer       -> reuse exact initial message snapshot
 *     web_search round    -> reload ordered messages after its tool rows persist
 *     escalation branch   -> exit without any credential lookup
 */

import { prisma } from '../database';
import { ensureChatContextWithinBudget } from './chatCompaction';
import { projectModelContextAfterCompaction } from './contextCompaction';
import { filterInternalSubagentMessages } from './contextScope';

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
    rootAgentId?: string;
    requestedModel: string;
    rawMessages: ChatMessage[];
  }) => Promise<ChatMessage[]>;
}

export interface InitialChatContext {
  messages: Promise<ChatMessage[]>;
}

interface StartInitialChatContextConfig {
  agentId: string;
  rootAgentId?: string;
  requestedModel: string;
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
  // Match the agent loop: drop spawned-agent work streams before budget math
  // and Router/Generator assembly. Compaction's estimator already ignores
  // subAgentId rows (mirroring agents/helpers/summarize.py); leaving them in
  // the chat path means ~800k real tokens can miss a 167k compact trigger.
  const rawMessages = filterInternalSubagentMessages(
    mapChatDatabaseMessages(await dependencies.findMessages(config.agentId))
  );
  const ensureWithinBudget = dependencies.ensureWithinBudget;
  if (!ensureWithinBudget) {
    return projectModelContextAfterCompaction(rawMessages);
  }
  return ensureWithinBudget({
    agentId: config.agentId,
    rootAgentId: config.rootAgentId,
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

function invoke<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return operation();
  } catch (error) {
    return Promise.reject(error);
  }
}
