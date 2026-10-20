/**
 * Who answers a pinned question (`display(..., placement: "pinned")`).
 *
 *   caller                     spawner                   route
 *   ───────────────────────    ───────────────────────   ─────────────────────────────
 *   root agent                 none                      user   (pin in root's trajectory)
 *   agent spawned by root      root                      user   (pin in caller's trajectory)
 *   code agent in root's tool  root (session agent)      user   (pin in root's trajectory)
 *   anything deeper            non-root agent P          parent (A2A message to P; P answers
 *                                                                or escalates; only root pins)
 *
 * `trajectoryAgentId` is the agent whose trajectory holds the caller's
 * messages: a Rose agent's own id, or the session agent for a code agent (code
 * agents post into the trajectory of the agent that ran the code-agent tool).
 *
 * This is the L-DISPLAY side of the routing decision. When L-A2A lands its
 * shared `{deliver_to, agent_id}` routing function, this module becomes a thin
 * adapter over it; callers depend only on `routeQuestion`.
 */

export interface QuestionRoute {
  deliver_to: 'user' | 'parent';
  agent_id: string;
}

export interface RoutingAgent {
  id: string;
  parentAgentId: string | null;
}

export function routeQuestion(input: {
  trajectoryAgentId: string;
  /** The agent that spawned the caller; null when the caller is the root agent. */
  spawner: RoutingAgent | null;
}): QuestionRoute {
  if (input.spawner === null || input.spawner.parentAgentId === null) {
    return { deliver_to: 'user', agent_id: input.trajectoryAgentId };
  }
  return { deliver_to: 'parent', agent_id: input.spawner.id };
}
