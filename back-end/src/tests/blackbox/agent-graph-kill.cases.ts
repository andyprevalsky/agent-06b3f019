/** Actual authenticated route: isolated owned rows, no native provider resources. */
import { randomUUID } from 'crypto';
import { prisma } from '../../providers/database';

export async function testParentKillBoundary(
  baseUrl: string,
  apiKey: string,
  root: string,
  foreign: string,
  userId: string,
  codeToken: string
) {
  const child = randomUUID(),
    grandchild = randomUUID(),
    sibling = randomUUID();
  const ids = [child, grandchild, sibling];
  const call = async (caller: string, target: string, bearer?: string) => {
    const response = await fetch(`${baseUrl}/api/agent-graph/agents/${target}`, {
      method: 'DELETE',
      headers: bearer
        ? { Authorization: `Bearer ${bearer}` }
        : { 'X-API-Key': apiKey, 'X-Agent-Id': caller },
    });
    return { status: response.status, body: await response.json() };
  };
  const assert = (condition: unknown, message: string) => {
    if (!condition) throw new Error(message);
  };
  try {
    for (const [id, parentAgentId] of [
      [child, root],
      [grandchild, child],
      [sibling, root],
    ]) {
      await prisma.agent.create({
        data: { id, userId, parentAgentId, goal: 'kill boundary fixture', status: 'ACTIVE' },
      });
    }
    assert((await call(root, root)).status === 403, 'self kill must be rejected');
    assert((await call(child, sibling)).status === 404, 'sibling kill must be rejected');
    assert((await call(root, foreign)).status === 404, 'foreign tree kill must be rejected');
    assert(
      (await call(root, child, codeToken)).status === 403,
      'code token cannot kill parent-owned agents'
    );
    const stopped = await call(root, child);
    assert(
      stopped.status === 200 && stopped.body.status === 'stopped',
      `stop failed: ${JSON.stringify(stopped)}`
    );
    assert(stopped.body.message.includes(child), 'readable receipt must identify the target');
    assert(
      stopped.body.message.includes(sibling),
      'readable receipt must identify preserved sibling state'
    );
    assert(
      (await prisma.agent.count({
        where: { id: { in: [child, grandchild] }, deletedAt: { not: null } },
      })) === 2,
      'subtree must be archived'
    );
    assert(
      (await prisma.agent.count({ where: { id: sibling, deletedAt: null } })) === 1,
      'sibling must survive'
    );
    assert((await call(root, child)).status === 200, 'repeat kill must be idempotent');
  } finally {
    await prisma.agent.deleteMany({ where: { id: { in: ids } } });
  }
}

export function killCases(
  baseUrl: string,
  apiKey: string,
  ids: { R: string; R2: string; S1: string; C: string },
  userId: string,
  codeToken: (id: string, owner: string) => string
): Array<[string, () => Promise<void>]> {
  return [
    [
      'parent kill enforces scope and recursively stops descendants idempotently',
      () =>
        testParentKillBoundary(baseUrl, apiKey, ids.R, ids.R2, userId, codeToken(ids.S1, ids.C)),
    ],
  ];
}
