/**
 * STATE MACHINE: useIndex01Setup
 *
 *   [IDLE] --open=true--> [LOADING] --POST /api/index01/credentials--> [READY]
 *                            |                                           |
 *                            +--error--> [ERROR] --reload()--> [LOADING]
 *   [any] --open=false--> [IDLE] on the next open it loads again, so the guide
 *   always shows the key the backend currently holds for the user.
 *
 * System context:
 *   PebbleIndexSetupModal -> this hook -> api/index01 -> backend mints (first
 *   time) / returns the user's dedicated "Index 01" Rose API key.
 */

import { useCallback, useEffect, useState } from 'react';

import { fetchIndex01CredentialsApi } from '../api/index01';
import type { Index01Credentials } from '../types';

export type Index01SetupState =
  | { status: 'loading' }
  | { status: 'ready'; credentials: Index01Credentials }
  | { status: 'error'; message: string };

export function useIndex01Setup(open: boolean): {
  state: Index01SetupState;
  reload: () => void;
} {
  const [state, setState] = useState<Index01SetupState>({ status: 'loading' });

  const reload = useCallback(() => {
    setState({ status: 'loading' });
    fetchIndex01CredentialsApi().then(
      (credentials) => setState({ status: 'ready', credentials }),
      (error: unknown) =>
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : 'Could not load Index 01 setup',
        }),
    );
  }, []);

  useEffect(() => {
    if (open) reload();
  }, [open, reload]);

  return { state, reload };
}
