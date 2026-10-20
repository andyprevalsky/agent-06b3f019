/**
 * Question routing by spawner (UI ledger 47b) for code agents.
 *
 *   spawned by the root agent  → deliver_to "user"  (the root pins it)
 *   spawned by any other agent → deliver_to "agent" (that Rose agent answers
 *                                from its context or escalates up the tree)
 *
 * `questionRouteForCodeSession` is the decision L-DISPLAY's pinned display
 * calls; `askQuestion` also performs the agent delivery via the A2A send path.
 */
import {
  questionRouteBySpawner,
  type QuestionRoute,
} from '../../providers/agentGraph/questionRoute';
import * as graphRepo from './repoGraph';
import { AgentGraphError, type GraphCaller } from './agentGraphService';
import { sendGraphMessage, type SendResult } from './agentGraphSendService';
import { markAwaitingParent } from '../../providers/codeSessions/spawn';

export type { QuestionRoute };

export async function questionRouteForSpawner(spawnerAgentId: string): Promise<QuestionRoute> {
  const spawner = await graphRepo.findGraphAgent(spawnerAgentId);
  if (spawner === null) throw new AgentGraphError(404, 'Agent not found');
  return questionRouteBySpawner(spawner);
}

/** The routing decision for one code session (L-DISPLAY's pinned questions). */
export async function questionRouteForCodeSession(sessionId: string): Promise<QuestionRoute> {
  const session = await graphRepo.findGraphCodeSession(sessionId);
  if (session === null) throw new AgentGraphError(404, 'Code session not found');
  return questionRouteForSpawner(session.agentId);
}

export interface QuestionOption {
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface AskInput {
  question: string;
  options?: QuestionOption[];
  allow_other?: boolean;
  message_id: string;
}

export function formatQuestionText(input: AskInput): string {
  const options = input.options ?? [];
  if (options.length === 0) return input.question;
  const lines = options.map((option, index) => {
    const description =
      option.description !== undefined && option.description !== ''
        ? ` — ${option.description}`
        : '';
    const recommended = option.recommended === true ? ' (recommended)' : '';
    return `${index + 1}. ${option.label}${recommended}${description}`;
  });
  if (input.allow_other !== false) lines.push(`${options.length + 1}. Other (free text)`);
  return `${input.question}\n\nOptions:\n${lines.join('\n')}`;
}

export type AskResult =
  | (QuestionRoute & { deliver_to: 'user'; status: 'pin_for_user' })
  | (QuestionRoute & { deliver_to: 'agent'; status: SendResult['status']; message_id: string });

/**
 * A code agent asks a question. Root-spawned: returns the `user` route and
 * sends nothing (the caller pins it via display). Otherwise the question goes
 * to the spawning Rose agent through the normal A2A send path, so it shows in
 * both transcripts and the answer comes back as the CLI's next user turn.
 */
export async function askQuestion(caller: GraphCaller, input: AskInput): Promise<AskResult> {
  if (caller.self.kind !== 'code') {
    throw new AgentGraphError(400, 'Question routing is for code agents');
  }
  const route = await questionRouteForSpawner(caller.self.ownerAgentId);
  if (route.deliver_to === 'user') return { ...route, deliver_to: 'user', status: 'pin_for_user' };
  const sent = await sendGraphMessage(
    caller,
    { to: route.agent_id, text: formatQuestionText(input), message_id: input.message_id },
    'question'
  );
  // The spawning agent is blocked inside this code agent's spawn: pause the
  // session and hand it the question instead of both waiting forever (C11).
  await markAwaitingParent(caller.self.id, {
    message_id: sent.message_id,
    question: input.question,
  });
  return { ...route, deliver_to: 'agent', status: sent.status, message_id: sent.message_id };
}
