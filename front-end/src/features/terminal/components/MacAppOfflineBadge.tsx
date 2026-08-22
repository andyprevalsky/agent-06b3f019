/**
 * STATE MACHINE: MacAppOfflineBadge
 *
 * [HIDDEN] --not signed in / in mac-app / relay connected / no iMessage setup-->
 * [PORTALLED PILL] --web + iMessage synced + relay offline--> top-right warning chip
 *
 * System context:
 *   Mac relay heartbeats are recorded when the desktop app polls the iMessage
 *   outbound queue. Web users with iMessage synced need a visible signal when
 *   that relay is stale so queued sends are expected.
 */

import { useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { TOP_RIGHT_INSPECTION_SLOT_ID } from '@/components/TopRightControls';
import { useAuth } from '@/features/auth';
import MacAppOfflineChip from '@/features/integrations/components/MacAppOfflineChip';
import { fetchIntegrationsApi } from '@/features/integrations/api';
import { useMacAppRelayStatus } from '@/features/integrations/hooks/useMacAppRelayStatus';
import { getClientSource } from '@/lib/clientSource';

export function MacAppOfflineBadge() {
  const { isFullySignedIn } = useAuth();
  const isWeb = getClientSource() === 'WEB';
  const enabled = isFullySignedIn && isWeb;
  const relayStatus = useMacAppRelayStatus(enabled);
  const [iMessageSynced, setIMessageSynced] = useState(false);
  const [slot, setSlot] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    setSlot(document.getElementById(TOP_RIGHT_INSPECTION_SLOT_ID));
  }, []);

  useLayoutEffect(() => {
    if (!enabled) {
      setIMessageSynced(false);
      return;
    }

    let cancelled = false;
    void fetchIntegrationsApi()
      .then((integrations) => {
        if (cancelled) return;
        setIMessageSynced(
          integrations.some(
            (integration) =>
              integration.name === 'imessage' &&
              integration.status === 'CONNECTED' &&
              integration.isActive,
          ),
        );
      })
      .catch((error) => {
        console.error('[MacAppOfflineBadge] Failed to load integrations:', error);
      });

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const relayOffline =
    relayStatus !== null && !relayStatus.connected && iMessageSynced;

  if (!relayOffline || slot === null) return null;

  return createPortal(
    <aside
      aria-label="Rose Mac app offline"
      aria-live="polite"
      data-testid="mac-app-offline-badge"
      role="status"
    >
      <MacAppOfflineChip />
    </aside>,
    slot,
  );
}
