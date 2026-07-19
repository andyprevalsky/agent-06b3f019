import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchWaitlistPeople, inviteWaitlistPerson } from '../api';
import type { AdminWaitlistInviteResponse, AdminWaitlistPerson } from '../types';

/**
 * Loads the actionable waitlist and owns the per-row invite mutation. Keeps the
 * data-access layer (../api) out of the component per the feature's layering
 * rules; the component only consumes state + the invite action.
 */
export function useWaitlistPeople() {
  const [people, setPeople] = useState<AdminWaitlistPerson[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [invitingIds, setInvitingIds] = useState<ReadonlySet<string>>(new Set());
  const attemptKeys = useRef(new Map<string, string>());

  useEffect(() => {
    let active = true;
    setPeople(null);
    setError(null);
    fetchWaitlistPeople()
      .then((result) => {
        if (active) setPeople(result.people);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
    };
  }, []);

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

  return { people, error, invitingIds, invite };
}
