/**
 * STATE MACHINE: MacAppOfflineChip
 *
 * [HIDDEN] --relay connected or not applicable--> (parent omits)
 * [VISIBLE] --Mac relay stale/offline--> compact warning chip
 *
 * Pure presentation: parent owns whether the Mac relay is offline.
 */

import ConnectedAccountChip from './ConnectedAccountChip';

interface MacAppOfflineChipProps {
  title?: string;
}

export default function MacAppOfflineChip({
  title = 'Rose Mac app is offline. iMessages queue until it reconnects.',
}: MacAppOfflineChipProps) {
  return (
    <ConnectedAccountChip label="Mac app offline" tone="warning" title={title} />
  );
}
