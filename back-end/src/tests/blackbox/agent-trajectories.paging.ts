/** Role and cursor contract against a root with one child agent. */

import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { MAX_RESULT_CHARS } from '../../domains/data/config';

type Response = { status: number; data: unknown };
type Grep = (userId: string, body: Record<string, unknown>) => Promise<Response>;

export async function proveCharacterBoundedPaging(grep: Grep, ownerId: string): Promise<void> {
  const root = await prisma.agent.create({
    data: {
      userId: ownerId,
      goal: 'Character-bounded cursor regression',
      source: 'WEB',
      status: 'COMPLETED',
    },
  });
  const messages = Array.from({ length: 3 }, (_, index) => ({
    id: randomUUID(),
    agentId: root.id,
    role: 'ASSISTANT' as const,
    text: `cursor-budget-${index} ${'x'.repeat(Math.floor(MAX_RESULT_CHARS * 0.6))}`,
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, index)),
  }));
  await prisma.message.createMany({ data: messages });
  let pageAfter: string | undefined;
  const paths = new Set<string>();
  for (let index = 0; index < messages.length; index++) {
    const response = await grep(ownerId, {
      source: 'agent_trajectories',
      trace_path: root.id,
      record_kind: 'message',
      order: 'oldest_first',
      head_limit: 10,
      ...(pageAfter === undefined ? {} : { page_after: pageAfter }),
    });
    const [match] = requireHits(response, 1);
    const page = response.data as {
      has_more: boolean;
      char_truncated?: boolean;
      next_page_after: string | null;
    };
    const path = String(match.path);
    const hasMore = index < messages.length - 1;
    if (
      paths.has(path) ||
      !path.endsWith(`/${messages[index].id}`) ||
      String(match.content).length > MAX_RESULT_CHARS ||
      page.has_more !== hasMore ||
      page.next_page_after !== (hasMore ? path : null) ||
      (hasMore && page.char_truncated !== true)
    ) {
      throw new Error(`Character-bound cursor skipped or repeated a row: ${JSON.stringify(page)}`);
    }
    paths.add(path);
    pageAfter = page.next_page_after ?? undefined;
  }
}

function requireHits(result: Response, count: number): Array<Record<string, unknown>> {
  const matches = (result.data as { matches?: Array<Record<string, unknown>> }).matches;
  if (result.status !== 200 || matches?.length !== count) {
    throw new Error(`Expected ${count} trajectory hits: ${JSON.stringify(result)}`);
  }
  return matches;
}

export async function proveTreeRolesAndPaging(
  grep: Grep,
  ownerId: string,
  otherId: string,
  priorId: string,
  priorChildId: string,
  currentId: string
): Promise<void> {
  requireHits(await grep(ownerId, { pattern: 'system-only decoy', trace_path: priorId }), 0);
  for (const query of [
    { pattern: 'system-only decoy', role: 'SYSTEM', trace_path: priorId },
    { pattern: 'system-only decoy', filters: { role: 'SYSTEM' }, trace_path: priorId },
    { trace_path: `agent_trajectories/${priorId}/SYSTEM/system-message` },
    { source: 'agent_network', pattern: 'system-only decoy', role: 'SYSTEM' },
  ]) {
    const result = await grep(ownerId, query);
    if (result.status !== 400) {
      throw new Error(`SYSTEM selector was accepted: ${JSON.stringify(result)}`);
    }
  }

  const treeQuery = {
    source: 'agent_trajectories',
    trace_path: priorId,
    record_kind: 'message',
    order: 'oldest_first',
    head_limit: 1,
    agent_id: currentId,
  };
  const all = requireHits(await grep(ownerId, { ...treeQuery, head_limit: 10 }), 2);
  const firstPage = await grep(ownerId, treeQuery);
  const [first] = requireHits(firstPage, 1);
  const pageAfter = (firstPage.data as { next_page_after?: string }).next_page_after;
  if (pageAfter !== first.path || !(firstPage.data as { has_more?: boolean }).has_more) {
    throw new Error(`Tree page lacks a usable cursor: ${JSON.stringify(firstPage)}`);
  }
  const secondPage = await grep(ownerId, { ...treeQuery, page_after: pageAfter });
  const [second] = requireHits(secondPage, 1);
  if (
    first.path !== all[0].path ||
    second.path !== all[1].path ||
    (secondPage.data as { next_page_after?: string | null }).next_page_after !== null
  ) {
    throw new Error(
      `Tree cursor skipped, repeated, or misordered messages: ${JSON.stringify(secondPage)}`
    );
  }
  requireHits(
    await grep(ownerId, {
      ...treeQuery,
      trace_path: `agent_trajectories/${priorId}/${priorChildId}`,
      role: 'TOOL',
    }),
    1
  );
  const foreignCursor = await grep(otherId, {
    ...treeQuery,
    page_after: pageAfter,
    agent_id: undefined,
  });
  if (foreignCursor.status !== 400) {
    throw new Error(`Foreign tree cursor was accepted: ${JSON.stringify(foreignCursor)}`);
  }
  const changedFilterCursor = await grep(ownerId, {
    ...treeQuery,
    role: first.role === 'TOOL' ? 'ASSISTANT' : 'TOOL',
    page_after: pageAfter,
  });
  if (changedFilterCursor.status !== 400) {
    throw new Error(
      `Cursor accepted a changed role filter: ${JSON.stringify(changedFilterCursor)}`
    );
  }
}
