/** Role and cursor contract against a root with one child agent. */

type Response = { status: number; data: unknown };
type Grep = (userId: string, body: Record<string, unknown>) => Promise<Response>;

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
  const [systemMessage] = requireHits(
    await grep(ownerId, { pattern: 'system-only decoy', role: 'SYSTEM', trace_path: priorId }),
    1
  );
  requireHits(await grep(ownerId, { pattern: 'system-only decoy', trace_path: priorId }), 0);
  requireHits(await grep(ownerId, { trace_path: systemMessage.path, role: 'SYSTEM' }), 1);

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
