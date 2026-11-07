/**
 * One chat grep round: the Router's grep arguments (the shared grep tool
 * definition, providers/grepTool) run once against the user's own data
 * through the same executor the explore agent and SMS supervisor use.
 *
 *   grep decision ──> ASSISTANT row with the Router's reasoning
 *                 ──> IN_PROGRESS chip (broadcast + TOOL row)
 *                 ──> executeUserDataGrepTool(userId, args, { agentId })
 *                       ├─ result ──> FINISHED TOOL row: "Grep <args>" + result JSON
 *                       └─ throws ──> ERROR TOOL row: "Grep <args>" + the error
 *
 * Every chip gets a terminal row, so the next route and the Generator always
 * read an outcome. Results are private user data: no DEMO cache, live every
 * time.
 */

import { v4 as uuidv4 } from 'uuid';

import { createMessage } from '../messages';
import { createLogger } from '../logger';
import { executeUserDataGrepTool } from '../userDataSearch';
import type { RouterDecision } from './routerDecision';
import { broadcastToolEvent, generateStreamId } from './supabaseBroadcast';

const log = createLogger('ChatHandler');

/** Same title rules as the explore agent's grep card (agents/domains/grep/service.py). */
const DISPLAY_PATTERN_MAX_LENGTH = 80;
const MESSAGE_TITLE_SOURCES = new Set(['', 'messages', 'email', 'gmail', 'imessage', 'whatsapp']);

export type GrepDecision = Extract<RouterDecision, { action: 'grep' }>;

export type ChatGrepRoundDeps = {
  createMessage: typeof createMessage;
  broadcastToolEvent: typeof broadcastToolEvent;
  executeUserDataGrepTool: typeof executeUserDataGrepTool;
};

const defaultDeps: ChatGrepRoundDeps = {
  createMessage,
  broadcastToolEvent,
  executeUserDataGrepTool,
};

/** Arguments as sent: omitted (null) values dropped, matching what the executor receives. */
function grepArguments(decision: GrepDecision): Record<string, unknown> {
  return JSON.parse(JSON.stringify(decision.grep)) as Record<string, unknown>;
}

function titleSource(args: Record<string, unknown>): string {
  if (typeof args.source === 'string' && args.source !== '') return args.source;
  if (Array.isArray(args.sources) && args.sources.length > 0) return args.sources.join(', ');
  const filters = args.filters;
  if (typeof filters === 'object' && filters !== null) {
    const named = Object.entries(filters).filter(
      ([, value]) => typeof value === 'object' && value !== null
    );
    if (named.length > 0) return named.map(([key]) => key).join(', ');
  }
  return '';
}

export function formatGrepTitle(prefix: string, args: Record<string, unknown>): string {
  const pattern = typeof args.pattern === 'string' ? args.pattern : '';
  const displayPattern =
    pattern.length <= DISPLAY_PATTERN_MAX_LENGTH
      ? pattern
      : `${pattern.slice(0, DISPLAY_PATTERN_MAX_LENGTH - 3)}...`;
  const source = titleSource(args);
  const label = source ? source.replace(/_/g, ' ') : 'all local data';
  if (displayPattern) return `${prefix} ${label} for "${displayPattern}"`;
  if (MESSAGE_TITLE_SOURCES.has(source.toLowerCase())) return `${prefix} ${label} for all messages`;
  return `${prefix} ${label}`;
}

export async function runChatGrepRound(
  params: {
    agentId: string;
    userId: string;
    decision: GrepDecision;
    /** Identity of the Router reasoning stream, distinct from the tool stream. */
    routerStreamId: string;
  },
  deps: ChatGrepRoundDeps = defaultDeps
): Promise<void> {
  const { agentId, userId, decision } = params;
  const args = grepArguments(decision);
  const streamId = generateStreamId();
  const toolCallId = uuidv4();
  const progressTitle = formatGrepTitle('Searching', args);
  const label = `Grep ${JSON.stringify(args)}`;

  log.info('[ChatHandler] Executing grep', { agentId, args: label.slice(0, 200) });

  // The Router's reasoning precedes its tool rows, matching worker behavior.
  await deps.createMessage({
    agentId,
    role: 'ASSISTANT',
    text: decision.reasoning,
    metadata: { streamId: params.routerStreamId },
  });
  await deps.broadcastToolEvent(
    agentId,
    streamId,
    toolCallId,
    'grep',
    'IN_PROGRESS',
    progressTitle
  );
  // createMessage() auto-broadcasts INSERT events to the frontend.
  await deps.createMessage({
    agentId,
    role: 'TOOL',
    text: '',
    skipDuplicateToolCheck: true,
    metadata: { title: progressTitle, toolName: 'grep', toolCallId, toolStatus: 'IN_PROGRESS' },
  });

  const startedAt = Date.now();
  try {
    const result = await deps.executeUserDataGrepTool(userId, args, { agentId });
    log.info('[ChatHandler] Grep complete', {
      agentId,
      sources: result.sources,
      totalMatches: result.total_matches,
      returned: result.returned,
      durationMs: Date.now() - startedAt,
    });
    await deps.createMessage({
      agentId,
      role: 'TOOL',
      text: `${label}\n\n${JSON.stringify(result)}`,
      skipDuplicateToolCheck: true,
      metadata: {
        title: formatGrepTitle('Searched', args),
        toolName: 'grep',
        toolCallId,
        toolStatus: 'FINISHED',
        grep: args,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('[ChatHandler] Grep failed', { agentId, error: message });
    await deps.createMessage({
      agentId,
      role: 'TOOL',
      text: `${label}\n\nError: ${message}`,
      skipDuplicateToolCheck: true,
      metadata: {
        title: formatGrepTitle('Grep failed searching', args),
        toolName: 'grep',
        toolCallId,
        toolStatus: 'ERROR',
        error: true,
        grep: args,
      },
    });
  }
}
