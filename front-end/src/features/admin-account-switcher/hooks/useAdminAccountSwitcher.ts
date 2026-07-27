/**
 * STATE MACHINE: useAdminAccountSwitcher
 *
 *   [CLOSED] --open()--> [OPEN, query='']
 *   [OPEN] --setQuery(q)--> debounce(SEARCH_DEBOUNCE_MS) --> [SEARCHING]
 *   [SEARCHING] --ok--> [OPEN, results]      --err--> [OPEN, error]
 *   [OPEN] --switchTo(userId)--> [SWITCHING]
 *   [SWITCHING] --ok--> admin session stashed, target session stored, RELOAD
 *   [SWITCHING] --err--> [OPEN, error]   (session untouched)
 *   [IMPERSONATING] --switchBack()--> admin session restored, RELOAD
 *                                     (or, if the stash expired, reload to sign-in)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  displayLabel,
  fetchAdminDirectory,
  returnToOwnAccount,
  switchToAccount,
} from '@/lib/adminUsers';
import {
  getImpersonatedAccount,
  IMPERSONATION_CHANGED_EVENT,
  type ImpersonatedAccount,
} from '@/lib/impersonation';

import { SEARCH_DEBOUNCE_MS, SEARCH_RESULT_LIMIT } from '../config';
import type { SwitchableAccount } from '../types';

function useImpersonatedAccount(): ImpersonatedAccount | null {
  const [account, setAccount] = useState<ImpersonatedAccount | null>(() =>
    getImpersonatedAccount(),
  );
  useEffect(() => {
    const sync = () => setAccount(getImpersonatedAccount());
    window.addEventListener(IMPERSONATION_CHANGED_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(IMPERSONATION_CHANGED_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  return account;
}

export function useAdminAccountSwitcher() {
  const impersonated = useImpersonatedAccount();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SwitchableAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [switchingUserId, setSwitchingUserId] = useState<string | null>(null);
  const requestId = useRef(0);

  const trimmedQuery = query.trim();

  useEffect(() => {
    if (!open || trimmedQuery === '') {
      setResults(null);
      setError(null);
      return;
    }
    const id = ++requestId.current;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      fetchAdminDirectory({
        search: trimmedQuery,
        page: 1,
        pageSize: SEARCH_RESULT_LIMIT,
        signal: controller.signal,
      })
        .then((response) => {
          if (id !== requestId.current) return;
          setError(null);
          setResults(
            response.people.filter((person): person is SwitchableAccount => person.userId !== null),
          );
        })
        .catch((err: unknown) => {
          if (id !== requestId.current || controller.signal.aborted) return;
          setResults([]);
          setError(err instanceof Error ? err.message : String(err));
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, trimmedQuery]);

  const switchTo = useCallback(async (userId: string) => {
    setSwitchingUserId(userId);
    setError(null);
    try {
      await switchToAccount(userId);
    } catch (err: unknown) {
      setSwitchingUserId(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const currentLabel = useMemo(
    () => (impersonated === null ? null : displayLabel(impersonated)),
    [impersonated],
  );

  return {
    impersonated,
    currentLabel,
    open,
    setOpen,
    query,
    setQuery,
    results,
    error,
    switchingUserId,
    switchTo,
    switchBack: returnToOwnAccount,
  };
}
