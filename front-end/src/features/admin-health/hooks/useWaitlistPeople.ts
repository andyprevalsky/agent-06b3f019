import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchWaitlistPeople, inviteWaitlistPerson } from '../api';
import type { AdminWaitlistInviteResponse, AdminWaitlistPerson } from '../types';

const WAITLIST_PAGE_SIZE = 50;

/**
 * Loads one bounded page of the actionable waitlist and owns page navigation
 * plus the per-row invite mutation. Keeps the data-access layer (../api) out of
 * the component per the feature's layering rules.
 */
export function useWaitlistPeople() {
  const [people, setPeople] = useState<AdminWaitlistPerson[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(WAITLIST_PAGE_SIZE);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [invitingIds, setInvitingIds] = useState<ReadonlySet<string>>(new Set());
  const attemptKeys = useRef(new Map<string, string>());

  useEffect(() => {
    let active = true;
    setPeople(null);
    setError(null);
    fetchWaitlistPeople(page, WAITLIST_PAGE_SIZE)
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
        if (active) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
    };
  }, [page]);

  const invite = useCallback(async (id: string): Promise<AdminWaitlistInviteResponse> => {
    setInvitingIds((prev) => new Set(prev).add(id));
    const idempotencyKey = attemptKeys.current.get(id) ?? crypto.randomUUID();
    attemptKeys.current.set(id, idempotencyKey);
    try {
      const result = await inviteWaitlistPerson(id, idempotencyKey);
      attemptKeys.current.delete(id);
      setPeople((prev) =>
        (prev ?? []).map((row) => (row.id === id ? { ...row, invitedAt: result.invitedAt } : row)),
      );
      return result;
    } finally {
      setInvitingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
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
