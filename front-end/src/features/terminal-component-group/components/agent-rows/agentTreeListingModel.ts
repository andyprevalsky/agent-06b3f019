/**
 * Pure model for the list_agents tree (metadata.agentTree on the tool row:
 * the bounded backend view the model's text was rendered from).
 *
 * Mirrors agents/domains/agent_messaging/service.py `_Relations` /
 * `_render_tree` / `_render_matches` so the FE tree and the model's text agree:
 *   - relationship of every node to the caller (you / parent / ancestor /
 *     child / descendant / sibling / other branch, "(root)" suffix)
 *   - the caller's own background tasks replace persisted task nodes
 *   - collapsed subtrees: "N children · k active" when children aren't listed
 *   - search mode (matches): flat rows with path breadcrumbs
 */

type Entry = Record<string, unknown>;

export interface ListingRow {
  id: string;
  path: string | null;
  name: string;
  type: string;
  status: string;
  goal: string;
  relation: string;
  isSelf: boolean;
  depth: number;
  /** Children not shown in this view: "4 children · 1 active". */
  hiddenChildren: string | null;
  navigable: boolean;
  breadcrumbs: string[];
}

export interface AgentListing {
  mode: 'tree' | 'matches';
  rows: ListingRow[];
  /** Caller's breadcrumb (root → you). */
  callerCrumbs: string[];
  hasMore: boolean;
}

function records(value: unknown): Entry[] {
  return Array.isArray(value)
    ? value.filter((v): v is Entry => typeof v === 'object' && v !== null)
    : [];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function lastSegment(path: string | null, fallback: string): string {
  if (!path) return fallback.length > 12 ? `${fallback.slice(0, 8)}…` : fallback;
  const segments = path.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

function childLabel(count: number, active: number): string {
  return `${count} ${count === 1 ? 'child' : 'children'} · ${active} active`;
}

class Relations {
  private parentOf = new Map<string, string | null>();
  private callerChain: string[];
  private rootId: string;

  constructor(
    view: Entry,
    private selfId: string,
  ) {
    this.rootId = text(view.root_agent_id);
    for (const key of ['caller_path', 'node_path']) {
      const chain = records(view[key]).map((e) => text(e.agent_id));
      chain.forEach((id, i) => {
        if (!this.parentOf.has(id)) this.parentOf.set(id, i ? chain[i - 1] : null);
      });
    }
    for (const node of records(view.nodes)) {
      if (node.agent_id)
        this.parentOf.set(text(node.agent_id), (node.parent_agent_id as string) ?? null);
    }
    for (const match of records(view.matches)) {
      const ancestors = (Array.isArray(match.ancestor_ids) ? match.ancestor_ids : []).map(text);
      ancestors.forEach((id, i) => {
        if (!this.parentOf.has(id)) this.parentOf.set(id, i ? ancestors[i - 1] : null);
      });
      this.parentOf.set(text(match.agent_id), ancestors[ancestors.length - 1] ?? null);
    }
    this.callerChain = records(view.caller_path).map((e) => text(e.agent_id));
  }

  private ancestors(id: string): string[] {
    const chain: string[] = [];
    let current = this.parentOf.get(id) ?? null;
    while (current && !chain.includes(current)) {
      chain.push(current);
      current = this.parentOf.get(current) ?? null;
    }
    return chain;
  }

  of(id: string): string {
    if (id === this.selfId) return 'you';
    let label: string;
    if (this.callerChain.includes(id)) {
      label = this.callerChain[this.callerChain.length - 2] === id ? 'parent' : 'ancestor';
    } else if (this.ancestors(id).includes(this.selfId)) {
      label = this.parentOf.get(id) === this.selfId ? 'child' : 'descendant';
    } else if (this.parentOf.get(id) && this.parentOf.get(id) === this.parentOf.get(this.selfId)) {
      label = 'sibling';
    } else {
      label = 'other branch';
    }
    return id === this.rootId ? `${label} · root` : label;
  }

  ofTask(ownerId: string, own: boolean): string {
    return own || ownerId === this.selfId
      ? 'your task'
      : `task of ${this.of(ownerId).replace(' · root', '')}`;
  }
}

function treeNodes(view: Entry, selfId: string): Entry[] {
  let nodes = records(view.nodes).filter((n) => n.agent_id);
  if (nodes.some((n) => text(n.agent_id) === selfId)) {
    // The caller's live task records replace their persisted copies.
    nodes = nodes.filter(
      (n) => !(text(n.type || 'agent') !== 'agent' && text(n.parent_agent_id) === selfId),
    );
    for (const task of records(view.own_tasks)) {
      nodes.push({
        agent_id: task.address,
        path: text(task.address).startsWith('/') ? task.address : null,
        type: task.type,
        status: task.status,
        goal: task.goal,
        parent_agent_id: selfId,
        own_task: true,
      });
    }
  }
  return nodes;
}

function buildTree(view: Entry, selfId: string, rel: Relations): ListingRow[] {
  const nodes = treeNodes(view, selfId);
  const listed = new Set(nodes.map((n) => text(n.agent_id)));
  const children = new Map<string | null, Entry[]>();
  for (const node of nodes) {
    const parent = text(node.parent_agent_id);
    const key = listed.has(parent) ? parent : null;
    children.set(key, [...(children.get(key) ?? []), node]);
  }
  const rows: ListingRow[] = [];
  const emit = (node: Entry, depth: number) => {
    const id = text(node.agent_id);
    const type = text(node.type || 'agent');
    const path = node.path ? text(node.path) : null;
    const kids = children.get(id) ?? [];
    const agentKids = kids.filter((k) => text(k.type || 'agent') === 'agent').length;
    const count = Number(node.child_count ?? 0);
    const hidden =
      type === 'agent' && count > agentKids
        ? childLabel(count - agentKids, Number(node.active_child_count ?? 0))
        : null;
    rows.push({
      id,
      path,
      name: lastSegment(path, id),
      type,
      status: text(node.status),
      goal: text(node.goal),
      relation:
        type === 'agent'
          ? rel.of(id)
          : rel.ofTask(text(node.parent_agent_id), node.own_task === true),
      isSelf: id === selfId,
      depth,
      hiddenChildren: hidden,
      navigable: type === 'agent' && id !== selfId,
      breadcrumbs: [],
    });
    kids.forEach((kid) => emit(kid, depth + 1));
  };
  (children.get(null) ?? []).forEach((top) => emit(top, 0));
  return rows;
}

function crumbsOf(match: Entry): string[] {
  const path = match.path ? text(match.path) : '';
  if (path) {
    const segments = path.split('/').filter(Boolean);
    return segments.slice(0, -1);
  }
  return (Array.isArray(match.ancestor_ids) ? match.ancestor_ids : []).map((id) =>
    lastSegment(null, text(id)),
  );
}

function buildMatches(view: Entry, rel: Relations): ListingRow[] {
  return records(view.matches)
    .filter((m) => m.agent_id)
    .map((match) => {
      const id = text(match.agent_id);
      const path = match.path ? text(match.path) : null;
      const count = Number(match.child_count ?? 0);
      return {
        id,
        path,
        name: lastSegment(path, id),
        type: 'agent',
        status: text(match.status),
        goal: text(match.goal),
        relation: rel.of(id),
        isSelf: false,
        depth: 0,
        hiddenChildren: count ? childLabel(count, Number(match.active_child_count ?? 0)) : null,
        navigable: true,
        breadcrumbs: crumbsOf(match),
      };
    });
}

/** Parses metadata.agentTree; null when absent or malformed (older rows). */
export function buildAgentListing(raw: unknown): AgentListing | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const view = raw as Entry;
  const selfId = text(view.self_agent_id);
  if (!selfId || (!Array.isArray(view.nodes) && !Array.isArray(view.matches))) return null;
  const rel = new Relations(view, selfId);
  const isSearch = Array.isArray(view.matches) && !records(view.nodes).length;
  return {
    mode: isSearch ? 'matches' : 'tree',
    rows: isSearch ? buildMatches(view, rel) : buildTree(view, selfId, rel),
    callerCrumbs: records(view.caller_path).map((e) =>
      lastSegment(e.path ? text(e.path) : null, text(e.agent_id)),
    ),
    hasMore: Boolean(view.next_cursor),
  };
}
