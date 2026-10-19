/** Agent-tree fixtures shared by the agent-to-agent messaging cases. */
import {
  BASE_URL,
  apiKeyHeaders,
  assert,
  createAnonymousSession,
  createTestAgent,
  deleteTestAgent,
  prisma,
  request,
} from './agents-blackbox-harness';

export interface Tree {
  userId: string;
  rootId: string;
  childId: string;
  grandchildId: string;
}

export async function createWorkflowAgent(userId: string, goal: string): Promise<string> {
  const agentId = await createTestAgent(userId, goal, { start_phase: 'execute' });
  const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
  assert(stored.temporalWorkflowId === agentId, 'fixture must own a running workflow');
  return agentId;
}

/** root → child → grandchild, linked the way spawn_agent links them (busId = root). */
export async function createTree(label: string): Promise<Tree> {
  const session = await createAnonymousSession(label);
  const userId = session.user.id;
  const rootId = await createWorkflowAgent(userId, `Plan a team offsite (${label})`);
  const childId = await createWorkflowAgent(userId, 'Do outreach to venues for the offsite');
  const grandchildId = await createWorkflowAgent(userId, 'Email the Napa venue about dates');
  await prisma.agent.update({
    where: { id: childId },
    data: { parentAgentId: rootId, busId: rootId, depth: 1 },
  });
  await prisma.agent.update({
    where: { id: grandchildId },
    data: { parentAgentId: childId, busId: rootId, depth: 2 },
  });
  return { userId, rootId, childId, grandchildId };
}

export async function deleteTree(tree: Tree): Promise<void> {
  for (const id of [tree.grandchildId, tree.childId, tree.rootId]) {
    await deleteTestAgent(id, tree.userId);
  }
}

export async function sendAgentMessage(
  userId: string,
  targetId: string,
  body: Record<string, unknown>
) {
  return request(`${BASE_URL}/api/agents/${targetId}/agent-messages`, {
    method: 'POST',
    headers: apiKeyHeaders(userId),
    body: JSON.stringify(body),
  });
}
