/**
 * The one question-routing decision (UI ledger 47b), shared by the agent-graph
 * domain (`questionRouteForSpawner`, POST /api/agent-graph/questions) and the
 * agent-tools domain (pinned `display`):
 *
 *   spawned by the root agent  → deliver_to "user"  (the root's user pins it)
 *   spawned by any other agent → deliver_to "agent" (that Rose agent answers
 *                                from its context or escalates up the tree)
 *
 * `agent_id` is always the spawner. Mirrors agents/helpers/agent_graph.py
 * `question_route_for_spawner`.
 */
export interface QuestionRoute {
  deliver_to: 'user' | 'agent';
  agent_id: string;
}

export function questionRouteBySpawner(spawner: {
  id: string;
  parentAgentId: string | null;
}): QuestionRoute {
  return {
    deliver_to: spawner.parentAgentId === null ? 'user' : 'agent',
    agent_id: spawner.id,
  };
}
