/**
 * Code agents (Claude Code / Codex sessions) for the Rose left bar.
 *
 * Each bar row is a tree root; GET /api/agents/code-agents?root_ids=<≤50 ids>
 * lists the sessions of those trees with their `root_agent_id`, and the bar
 * shows them under that root row (sessions owned by a sub-agent sit under its
 * root; opening one selects its `owner_agent_id`).
 *
 * STATE MACHINE (per page of CODE_AGENT_LIST_MAX_ROOTS roots in display order):
 *   [IDLE]    no root of the page on screen (and not selected) → no request
 *   [WANTED]  a root scrolls into view / is selected → ONE batched request
 *   [FRESH]   kept 5 min; a page with an on-screen running root re-reads every
 *             30s while the document is visible (never in the background)
 *   [CACHED]  scrolled away → no observer, no request; its rows stay listed
 *             (read from the query cache, newest read per root wins) so rows
 *             above the viewport never collapse and shift the list
 *   page composition changes → new page key; cached rows show until it lands
 *
 * Holds at 10k agents: rows register with ONE IntersectionObserver, so the
 * requests are bounded by the pages on screen (+ the selected row's page),
 * never by the agent count; nothing polls while no running root is visible.
 * Without IntersectionObserver the first page counts as on screen.
 */

import { useQueries, useQueryClient, type Query } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  CODE_AGENT_LIST_MAX_ROOTS,
  fetchCodeAgentsForRoots,
  type CodeAgentListItem,
} from '@/lib/api/tree';

import { agentRunStatus } from '../agentRunState';
import type { Agent } from '../../hooks';

const QUERY_KEY = 'rose-code-agents';
const RUNNING_REFRESH_MS = 30_000;
const FINISHED_STALE_MS = 5 * 60_000;
/** Pages scrolled away stay readable this long (≤500 rows each, never re-requested). */
const CACHED_PAGE_GC_MS = 30 * 60_000;

const NO_CODE_AGENTS: readonly CodeAgentListItem[] = [];
const NO_ROOTS: ReadonlySet<string> = new Set<string>();

type RowRef = (element: HTMLElement | null) => void;

function withVisibility(prev: ReadonlySet<string>, changes: Map<string, boolean>) {
  const next = new Set(prev);
  for (const [id, onScreen] of changes) {
    if (onScreen) next.add(id);
    else next.delete(id);
  }
  if (next.size === prev.size && [...next].every((id) => prev.has(id))) return prev;
  return next;
}

/** Root ids whose rows are on screen, via one shared IntersectionObserver. */
function useOnScreenRoots(): {
  onScreen: ReadonlySet<string>;
  observeRoot: (id: string) => RowRef;
} {
  const [onScreen, setOnScreen] = useState<ReadonlySet<string>>(NO_ROOTS);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const idByElement = useRef(new Map<Element, string>());
  const elementById = useRef(new Map<string, Element>());
  const refs = useRef(new Map<string, RowRef>());

  const observer = useCallback((): IntersectionObserver | null => {
    if (observerRef.current) return observerRef.current;
    if (typeof IntersectionObserver === 'undefined') return null;
    observerRef.current = new IntersectionObserver((entries) => {
      const changes = new Map<string, boolean>();
      for (const entry of entries) {
        const id = idByElement.current.get(entry.target);
        if (id !== undefined) changes.set(id, entry.isIntersecting);
      }
      if (changes.size > 0) setOnScreen((prev) => withVisibility(prev, changes));
    });
    return observerRef.current;
  }, []);

  useEffect(() => () => observerRef.current?.disconnect(), []);

  const observeRoot = useCallback(
    (id: string): RowRef => {
      const existing = refs.current.get(id);
      if (existing) return existing;
      const ref: RowRef = (element) => {
        const previous = elementById.current.get(id);
        if (previous && previous !== element) {
          observer()?.unobserve(previous);
          idByElement.current.delete(previous);
          elementById.current.delete(id);
          setOnScreen((prev) => withVisibility(prev, new Map([[id, false]])));
        }
        if (element && previous !== element) {
          elementById.current.set(id, element);
          idByElement.current.set(element, id);
          observer()?.observe(element);
        }
      };
      refs.current.set(id, ref);
      return ref;
    },
    [observer],
  );

  return { onScreen, observeRoot };
}

interface RootPage {
  ids: string[];
  /** A running root of this page is on screen: re-read while the document is visible. */
  live: boolean;
}

function wantedPages(
  agents: Agent[],
  onScreen: ReadonlySet<string>,
  selectedAgentId: string | null,
): RootPage[] {
  const observable = typeof IntersectionObserver !== 'undefined';
  const pages: RootPage[] = [];
  for (let start = 0; start < agents.length; start += CODE_AGENT_LIST_MAX_ROOTS) {
    const page = agents.slice(start, start + CODE_AGENT_LIST_MAX_ROOTS);
    const shown = page.filter((a) => (observable ? onScreen.has(a.agent_id) : start === 0));
    const selected = page.some((a) => a.agent_id === selectedAgentId);
    if (shown.length === 0 && !selected) continue;
    pages.push({
      // Sorted: a reorder inside the same page (e.g. projects loading) keeps its cache key.
      ids: page.map((a) => a.agent_id).sort(),
      live: shown.some((a) => agentRunStatus(a).state === 'active'),
    });
  }
  return pages;
}

export interface RoseCodeAgents {
  /** Code agents under a bar row (its tree's sessions), oldest first. */
  codeAgentsFor: (agentId: string) => readonly CodeAgentListItem[];
  /** Ref for a root row: its visibility decides which pages are read. */
  observeRoot: (agentId: string) => RowRef;
}

/**
 * Rows per root from every cached page read (on screen or not), the newest read
 * of a root winning; a root its newest page listed without rows maps to [].
 */
function rowsByRoot(queries: readonly Query[]): Map<string, CodeAgentListItem[]> {
  const byRoot = new Map<string, CodeAgentListItem[]>();
  const read = queries
    .filter((query) => Array.isArray(query.state.data))
    .sort((a, b) => a.state.dataUpdatedAt - b.state.dataUpdatedAt);
  for (const query of read) {
    const grouped = new Map<string, CodeAgentListItem[]>();
    for (const row of query.state.data as CodeAgentListItem[]) {
      grouped.set(row.root_agent_id, [...(grouped.get(row.root_agent_id) ?? []), row]);
    }
    for (const id of String(query.queryKey[1]).split(',')) {
      const rows = grouped.get(id) ?? [];
      rows.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      byRoot.set(id, rows);
    }
  }
  return byRoot;
}

export function useRoseCodeAgents(agents: Agent[], selectedAgentId: string | null): RoseCodeAgents {
  const { onScreen, observeRoot } = useOnScreenRoots();
  const pages = wantedPages(agents, onScreen, selectedAgentId);
  const queryCache = useQueryClient().getQueryCache();
  // Stable combine: re-runs only when a wanted page's result changes; the rows
  // come from every cached page, so pages scrolled away keep their rows.
  const combine = useCallback(
    () => rowsByRoot(queryCache.findAll({ queryKey: [QUERY_KEY] })),
    [queryCache],
  );
  const byRoot = useQueries({
    queries: pages.map((page) => ({
      queryKey: [QUERY_KEY, page.ids.join(',')],
      queryFn: () => fetchCodeAgentsForRoots(page.ids),
      staleTime: page.live ? RUNNING_REFRESH_MS : FINISHED_STALE_MS,
      gcTime: CACHED_PAGE_GC_MS,
      refetchInterval: page.live ? RUNNING_REFRESH_MS : (false as const),
      retry: false,
    })),
    combine,
  });
  const codeAgentsFor = useCallback(
    (agentId: string) => byRoot.get(agentId) ?? NO_CODE_AGENTS,
    [byRoot],
  );
  return { codeAgentsFor, observeRoot };
}
