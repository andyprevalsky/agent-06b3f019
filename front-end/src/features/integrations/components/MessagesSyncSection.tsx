/**
 * STATE MACHINE: MessagesSyncSection
 *
 * [COLLAPSED] --toggle--> [EXPANDED] --toggle--> [COLLAPSED]
 *
 * Sub-items:
 *   iMessage: [IDLE] --click--> [SYNCING] --done--> [SYNCED]  (Desktop only)
 *             a shareable connected iMessage shows its team-sharing caption by its name
 *   Gmail:    [IDLE] --plus click--> [CONNECTING] --OAuth--> [CONNECTED + email chips]
 *   WhatsApp: [DESKTOP_ONLY + download] --paired in Mac app--> [CONNECTED]
 *   Telegram, Messenger: [COMING_SOON] (static)
 */

import { Button } from '@/components/ui/button';
import { AccountTeamShare } from '@/components/teams/TeamSharing';
import { useAccountShares } from '@/hooks/useTeams';

import { hasDamagedGmailAccount } from '../hooks/useIntegrationData';
import type { ConnectedIntegration, MessageSyncType } from '../types';
import DropdownIconFrame, { DropdownIconPreset, warningGlowGradient } from './DropdownIconFrame';
import GmailRow from './GmailRow';
import { ChatSyncIcon, IMessageIcon, MessengerIcon, TelegramIcon } from './MessageSyncIcons';
import SectionToggleButton from './SectionToggleButton';
import WhatsAppRow from './WhatsAppRow';
import SyncItemButton from './SyncItemButton';

interface MessagesSyncSectionProps {
  expanded: boolean;
  onToggle: () => void;
  isIMessageAvailable: boolean;
  isWhatsAppAvailable: boolean;
  iMessageSynced: boolean;
  whatsAppConnected: boolean;
  messageSyncLoading: MessageSyncType | null;
  onIMessageSync: () => void;
  onWhatsAppConnect: () => void;
  connectedIntegrations: ConnectedIntegration[];
  connectingProvider: 'gmail' | null;
  disconnectingEmail: string | null;
  resyncingEmail: string | null;
  onGmailConnect: () => void;
  onGmailDisconnect: (email: string) => void;
  onGmailResync: (email: string) => void;
}

const COMING_SOON_BADGE = (
  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
    Coming Soon
  </span>
);

function ComingSoonRow({
  icon,
  iconFrameProps = {},
  label,
  borderBottom = true,
}: {
  icon: React.ReactNode;
  iconFrameProps?: Pick<React.ComponentProps<typeof DropdownIconFrame>, 'iconFit' | 'iconScale'>;
  label: string;
  borderBottom?: boolean;
}) {
  return (
    <div
      className={`px-4 py-2 flex items-center justify-between${borderBottom ? ' border-b border-border/50' : ''}`}
    >
      <div className="flex items-center gap-3">
        <DropdownIconFrame {...iconFrameProps}>{icon}</DropdownIconFrame>
        <span className="text-sm">{label}</span>
      </div>
      {COMING_SOON_BADGE}
    </div>
  );
}

function IMessageRow({
  isAvailable,
  synced,
  loading,
  onSync,
}: {
  isAvailable: boolean;
  synced: boolean;
  loading: MessageSyncType | null;
  onSync: () => void;
}) {
  const target = useAccountShares().shareTarget('imessage');
  const share = target && <AccountTeamShare {...target} />;
  if (isAvailable) {
    return (
      <div className="px-4 py-2 flex items-center justify-between border-b border-border/50">
        <div className="flex items-center gap-3">
          <DropdownIconFrame {...DropdownIconPreset.imessage} isSynced={synced}>
            <IMessageIcon gradientId="imessageGrad" />
          </DropdownIconFrame>
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="truncate text-sm">iMessage</span>
            {share}
          </div>
        </div>
        <SyncItemButton isLoading={loading === 'imessage'} isSynced={synced} onClick={onSync} />
      </div>
    );
  }
  return (
    <div className="px-4 py-2 flex items-center justify-between flex-wrap gap-2 border-b border-border/50">
      <div className="flex items-center gap-3">
        <DropdownIconFrame {...DropdownIconPreset.imessage}>
          <IMessageIcon gradientId="imessageGradAlt" />
        </DropdownIconFrame>
        <div className="flex items-center gap-2">
          <span className="text-sm">iMessage</span>
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
            Desktop Only
          </span>
          {share}
        </div>
      </div>
      <Button size="sm" variant="outline" asChild>
        <a href="/download">Download for Mac</a>
      </Button>
    </div>
  );
}

function MessageServiceRows({
  isIMessageAvailable,
  isWhatsAppAvailable,
  iMessageSynced,
  whatsAppConnected,
  messageSyncLoading,
  onIMessageSync,
  onWhatsAppConnect,
  connectedIntegrations,
  connectingProvider,
  disconnectingEmail,
  resyncingEmail,
  onGmailConnect,
  onGmailDisconnect,
  onGmailResync,
}: MessagesSyncSectionProps) {
  return (
    <div className="border-t border-border">
      <IMessageRow
        isAvailable={isIMessageAvailable}
        synced={iMessageSynced}
        loading={messageSyncLoading}
        onSync={onIMessageSync}
      />
      <GmailRow
        connectedIntegrations={connectedIntegrations}
        connectingProvider={connectingProvider}
        disconnectingEmail={disconnectingEmail}
        resyncingEmail={resyncingEmail}
        onGmailConnect={onGmailConnect}
        onGmailDisconnect={onGmailDisconnect}
        onGmailResync={onGmailResync}
      />
      <WhatsAppRow
        connected={whatsAppConnected}
        isAvailable={isWhatsAppAvailable}
        isLoading={messageSyncLoading === 'whatsapp'}
        onConnect={onWhatsAppConnect}
      />
      <ComingSoonRow
        icon={<TelegramIcon />}
        iconFrameProps={DropdownIconPreset.telegram}
        label="Telegram"
      />
      <ComingSoonRow
        icon={<MessengerIcon />}
        iconFrameProps={DropdownIconPreset.messenger}
        label="Messenger"
        borderBottom={false}
      />
    </div>
  );
}

export default function MessagesSyncSection(props: MessagesSyncSectionProps) {
  const { expanded, onToggle, iMessageSynced, whatsAppConnected, connectedIntegrations } = props;
  const anyMessageConnected =
    iMessageSynced || whatsAppConnected || connectedIntegrations.some((i) => i.name === 'gmail');
  const needsReconnection = hasDamagedGmailAccount(connectedIntegrations);
  return (
    <div className="rounded-lg border border-border bg-card/60 overflow-hidden">
      <div className="p-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <DropdownIconFrame
            {...DropdownIconPreset.messagesMain}
            isSynced={anyMessageConnected}
            glowGradient={needsReconnection ? warningGlowGradient : undefined}
          >
            <ChatSyncIcon />
          </DropdownIconFrame>
          <div className="flex flex-col">
            <h3 className="font-medium">Messages</h3>
            <span className="text-xs text-muted-foreground">Sync messaging clients</span>
          </div>
        </div>
        <SectionToggleButton
          isConnected={anyMessageConnected}
          needsReconnection={needsReconnection}
          onClick={onToggle}
          sectionLabel="Messages"
        />
      </div>
      {expanded && <MessageServiceRows {...props} />}
    </div>
  );
}
