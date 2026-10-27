/**
 * STATE MACHINE: usePlaidIntegration
 *
 *   Orchestrates the Plaid feature's `usePlaidConnect` + `usePlaidItems` hooks
 *   into a single object the IntegrationSections card consumes.
 *
 *   [LOADING] --first fetch--> [LOADED]
 *     --connect()--> [CONNECTING] --success--> [LOADED + new item]
 *     --update(id)--> [CONNECTING] --success--> [LOADED + repaired item]
 *     --disconnect(id)--> [DISCONNECTING(id)] --success--> [LOADED - item]
 *     --refresh()--> [LOADED] (in-place re-read; drives sync progress polling)
 */

import { useCallback, useState } from 'react';

import { usePlaidConnect } from './usePlaidConnect';
import { usePlaidItems } from './usePlaidItems';
import type { PlaidItem } from '../types';

export function usePlaidIntegration(): {
  items: PlaidItem[];
  itemsLoading: boolean;
  connectLoading: boolean;
  disconnectingItemId: string | null;
  error: string | null;
  onConnect: () => void;
  onUpdate: (itemId: string) => void;
  onDisconnect: (itemId: string) => void;
  /** Re-read the items (Rose Desktop polls this while an item is syncing). */
  refresh: () => Promise<void>;
} {
  const items = usePlaidItems();
  const [disconnectingItemId, setDisconnectingItemId] = useState<string | null>(null);

  const connect = usePlaidConnect({
    onConnected: () => {
      void items.refresh();
    },
    onDisconnected: () => {
      setDisconnectingItemId(null);
      void items.refresh();
    },
  });

  const onConnect = useCallback(() => {
    void connect.connect();
  }, [connect]);

  const onUpdate = useCallback(
    (itemId: string) => {
      void connect.update(itemId);
    },
    [connect],
  );

  const onDisconnect = useCallback(
    (itemId: string) => {
      setDisconnectingItemId(itemId);
      void connect.disconnect(itemId);
    },
    [connect],
  );

  const connectLoading =
    connect.state === 'fetching_link_token' ||
    connect.state === 'link_open' ||
    connect.state === 'exchanging';

  return {
    items: items.items,
    itemsLoading: items.loading,
    connectLoading,
    disconnectingItemId,
    error: items.error ?? connect.error,
    onConnect,
    onUpdate,
    onDisconnect,
    refresh: items.refresh,
  };
}
