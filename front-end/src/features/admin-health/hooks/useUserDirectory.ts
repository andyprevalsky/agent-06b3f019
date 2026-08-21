/**
 * STATE MACHINE: useUserDirectory
 *
 *   [LOADING(page n, q)] --ok--> [READY] --(no rows)--> [EMPTY]
 *          |                        |
 *          +--err--> [ERROR]        +--setSearch(q')--> page resets to 1, [LOADING]
 *                                   +--Previous/Next--> [LOADING(page n±1)]
 *
 * Per row (independent):
 *   [IDLE] --Invite--> [SENDING] --ok--> [INVITED]   --err--> [IDLE] (retryable)
 *   [IDLE] --Switch--> handled by the account switcher (full page reload)
 *
 * Backed by GET /api/admin-health/users, which merges real accounts with
 * phone-bearing waitlist signups so one page covers "who is in the app" and
 * "who is waiting to get in".
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchAdminDirectory, type AdminDirectoryPerson } from '@/lib/adminUsers';

import { inviteWaitlistPerson } from '../api';
import type { AdminWaitlistInviteResponse } from '../types';

const DIRECTORY_PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 250;

export function useUserDirectory() {
  const [people, setPeople] = useState<AdminDirectoryPerson[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearchValue] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DIRECTORY_PAGE_SIZE);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [invitingIds, setInvitingIds] = useState<ReadonlySet<string>>(new Set());
  const attemptKeys = useRef(new Map<string, string>());

  // Debounce typing into the applied term so each keystroke doesn't hit the DB.
  useEffect(() => {
    const normalizedSearch = search.trim();
    // On mount (and after a term has settled), there is nothing to apply. In
    // particular, do not schedule a stale page-1 reset that can race a quick
    // pagination click during the initial debounce window.
    if (normalizedSearch === appliedSearch) return;
    const timer = window.setTimeout(() => {
      setAppliedSearch(normalizedSearch);
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [search, appliedSearch]);

  useEffect(() => {
    let active = true;
    // `active` only discards the RESULT; without a signal the superseded request
    // still runs to completion. Every keystroke would otherwise leave its fetch
    // in flight against the admin directory.
    const controller = new AbortController();
    setPeople(null);
    setError(null);
    fetchAdminDirectory({
      search: appliedSearch,
      page,
      pageSize: DIRECTORY_PAGE_SIZE,
      signal: controller.signal,
    })
      .then((result) => {
        if (!active) return;
        setTotal(result.total);
        setTotalPages(result.totalPages);
        setPageSize(result.pageSize);
        if (result.page > result.totalPages) {
          setPage(result.totalPages);
          return;
        }
        setPeople(result.people);
      })
      .catch((err: unknown) => {
        // An abort is this effect superseding itself, not a failure to surface.
        if (active && !(err instanceof DOMException && err.name === 'AbortError')) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [page, appliedSearch]);

  const invite = useCallback(async (waitlistId: string): Promise<AdminWaitlistInviteResponse> => {
    setInvitingIds((prev) => new Set(prev).add(waitlistId));
    const idempotencyKey = attemptKeys.current.get(waitlistId) ?? crypto.randomUUID();
    attemptKeys.current.set(waitlistId, idempotencyKey);
    try {
      const result = await inviteWaitlistPerson(waitlistId, idempotencyKey);
      attemptKeys.current.delete(waitlistId);
      setPeople((prev) =>
        (prev ?? []).map((row) =>
          row.waitlistId === waitlistId ? { ...row, invitedAt: result.invitedAt } : row,
        ),
      );
      return result;
    } finally {
      setInvitingIds((prev) => {
        const next = new Set(prev);
        next.delete(waitlistId);
        return next;
      });
    }
  }, []);

  const previousPage = useCallback(() => {
    setPage((current) => Math.max(1, current - 1));
  }, []);

  const nextPage = useCallback(() => {
    setPage((current) => Math.min(totalPages, current + 1));
  }, [totalPages]);

  return {
    people,
    error,
    search,
    setSearch: setSearchValue,
    invitingIds,
    invite,
    page,
    pageSize,
    total,
    totalPages,
    previousPage,
    nextPage,
  };
}
