/**
 * Question routing by spawner (UI ledger 47b) for code agents.
 *
 *   spawned by the root agent  → deliver_to "user"  (the root pins it)
 *   spawned by any other agent → deliver_to "agent" (that Rose agent answers
 *                                from its context or escalates up the tree)
 *   deleted → 404
 *
 * Read-only routing decision (GET /api/agent-graph/question-route). Code agents
 * cannot ask questions: there is no ask route.
 */
import {
  questionRouteBySpawner,
  type QuestionRoute,
} from '../../providers/agentGraph/questionRoute';
import * as graphRepo from './repoGraph';
import { AgentGraphError } from './agentGraphService';

export type { QuestionRoute };

export async function questionRouteForSpawner(spawnerAgentId: string): Promise<QuestionRoute> {
  const spawner = await graphRepo.findGraphAgent(spawnerAgentId);
  if (spawner === null) throw new AgentGraphError(404, 'Agent not found');
  return questionRouteBySpawner(spawner);
}

/** The routing decision for one code session. */
export async function questionRouteForCodeSession(sessionId: string): Promise<QuestionRoute> {
  const session = await graphRepo.findGraphCodeSession(sessionId);
  if (session === null) throw new AgentGraphError(404, 'Code session not found');
  return questionRouteForSpawner(session.agentId);
}
