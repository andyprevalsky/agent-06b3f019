/**
 * STATE MACHINE: WhatsAppRow
 *
 *   [CONNECTED]        --> synced icon glow + "Synced" chip + its team-sharing caption
 *                          (AccountTeamShare, when the backend lists WhatsApp as shareable)
 *   [DESKTOP_READY]    --connect--> [PAIRING] --paired--> [CONNECTED]
 *   [WEB]              --> "Desktop Only" + download link
 *
 * System context:
 *   Messages section row -> IntegrationHandlers.whatsApp.connect() -> desktop
 *     shell (QR modal + native bridge) -> WhatsApp device link -> integrations refetch
 *
 * DESKTOP_READY exists because pairing needs a QR scan the web build cannot do.
 * Without it the Mac app -- which renders this same shared component -- fell to
 * the web branch and offered to download the app the user was already running.
 */

import { Button } from '@/components/ui/button';
import { AccountTeamShare } from '@/components/teams/TeamSharing';
import { useAccountShares } from '@/hooks/useTeams';

import ConnectedAccountChip from './ConnectedAccountChip';
import DropdownIconFrame, { DropdownIconPreset } from './DropdownIconFrame';
import { WhatsAppIcon } from './MessageSyncIcons';
import SyncItemButton from './SyncItemButton';

interface WhatsAppRowProps {
  connected: boolean;
  isAvailable: boolean;
  isLoading: boolean;
  onConnect: () => void;
}

const ROW = 'px-4 py-2 flex items-center justify-between border-b border-border/50';

function WhatsAppLabel({
  isSynced = false,
  badge,
}: {
  isSynced?: boolean;
  /** Rendered next to the name, e.g. the web build's "Desktop Only" pill or the sharing caption. */
  badge?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3">
      <DropdownIconFrame {...DropdownIconPreset.whatsapp} isSynced={isSynced}>
        <WhatsAppIcon />
      </DropdownIconFrame>
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm">WhatsApp</span>
        {badge}
      </div>
    </div>
  );
}

export default function WhatsAppRow({
  connected,
  isAvailable,
  isLoading,
  onConnect,
}: WhatsAppRowProps) {
  const target = useAccountShares().shareTarget('whatsapp');
  if (connected) {
    return (
      <div className={ROW}>
        <WhatsAppLabel isSynced badge={target && <AccountTeamShare {...target} />} />
        <ConnectedAccountChip label="Synced" tone="synced" />
      </div>
    );
  }

  if (isAvailable) {
    return (
      <div className={ROW}>
        <WhatsAppLabel />
        <SyncItemButton
          ariaLabel="Connect WhatsApp"
          isLoading={isLoading}
          isSynced={false}
          onClick={onConnect}
        />
      </div>
    );
  }

  return (
    <div className={`${ROW} flex-wrap gap-2`}>
      <WhatsAppLabel
        badge={
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
            Desktop Only
          </span>
        }
      />
      <Button size="sm" variant="outline" asChild>
        <a href="/download">Download for Mac</a>
      </Button>
    </div>
  );
}
