/**
 * STATE MACHINE: MessagesSyncSection
 *
 * [COLLAPSED] --toggle--> [EXPANDED] --toggle--> [COLLAPSED]
 *
 * Sub-items:
 *   iMessage: [IDLE] --click--> [SYNCING] --done--> [SYNCED]  (Desktop only)
 *   Gmail:    [IDLE] --plus click--> [CONNECTING] --OAuth--> [CONNECTED + email chips]
 *   WhatsApp: [DESKTOP_ONLY + download] --paired in Mac app--> [CONNECTED]
 *   Telegram, Messenger: [COMING_SOON] (static)
 */

import { Loader2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';

import type { ConnectedIntegration, MessageSyncType } from '../types';
import ConnectedAccountChip from './ConnectedAccountChip';
import DropdownIconFrame, { DropdownIconPreset } from './DropdownIconFrame';
import {
  ChatSyncIcon,
  GmailIcon,
  IMessageIcon,
  MessengerIcon,
  TelegramIcon,
  WhatsAppIcon,
} from './MessageSyncIcons';
import SectionToggleButton from './SectionToggleButton';
import SyncItemButton from './SyncItemButton';

interface MessagesSyncSectionProps {
  expanded: boolean;
  onToggle: () => void;
  isIMessageAvailable: boolean;
  iMessageSynced: boolean;
  whatsAppConnected: boolean;
  messageSyncLoading: MessageSyncType | null;
  onIMessageSync: () => void;
  connectedIntegrations: ConnectedIntegration[];
  connectingProvider: 'gmail' | null;
  disconnectingEmail: string | null;
  onGmailConnect: () => void;
  onGmailDisconnect: (email: string) => void;
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
  if (isAvailable) {
    return (
      <div className="px-4 py-2 flex items-center justify-between border-b border-border/50">
        <div className="flex items-center gap-3">
          <DropdownIconFrame {...DropdownIconPreset.imessage} isSynced={synced}>
            <IMessageIcon gradientId="imessageGrad" />
          </DropdownIconFrame>
          <div className="flex min-w-0 items-center">
            <span className="truncate text-sm">iMessage</span>
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
        </div>
      </div>
      <Button size="sm" variant="outline" asChild>
        <a href="/download">Download for Mac</a>
      </Button>
    </div>
  );
}

function WhatsAppRow({ connected }: { connected: boolean }) {
  if (connected) {
    return (
      <div className="px-4 py-2 flex items-center justify-between border-b border-border/50">
        <div className="flex items-center gap-3">
          <DropdownIconFrame {...DropdownIconPreset.whatsapp} isSynced>
            <WhatsAppIcon />
          </DropdownIconFrame>
          <span className="truncate text-sm">WhatsApp</span>
        </div>
        <ConnectedAccountChip label="Synced" tone="synced" />
      </div>
    );
  }
  return (
    <div className="px-4 py-2 flex items-center justify-between flex-wrap gap-2 border-b border-border/50">
      <div className="flex items-center gap-3">
        <DropdownIconFrame {...DropdownIconPreset.whatsapp}>
          <WhatsAppIcon />
        </DropdownIconFrame>
        <div className="flex items-center gap-2">
          <span className="text-sm">WhatsApp</span>
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
            Desktop Only
          </span>
        </div>
      </div>
      <Button size="sm" variant="outline" asChild>
        <a href="/download">Download for Mac</a>
      </Button>
    </div>
  );
}

function GmailEmails({
  connectedIntegrations,
  disconnectingEmail,
  onGmailDisconnect,
}: {
  connectedIntegrations: ConnectedIntegration[];
  disconnectingEmail: string | null;
  onGmailDisconnect: (email: string) => void;
}) {
  const gmail = connectedIntegrations.find((i) => i.name === 'gmail');
  const emails =
    gmail?.config?.connectedEmails ||
    (gmail?.config?.connectedEmail ? [gmail.config.connectedEmail] : []);
  if (emails.length === 0) return null;

  return (
    <div className="mt-1 flex min-w-0 flex-wrap gap-1.5">
      {(emails as string[]).map((email: string) => (
        <ConnectedAccountChip
          key={email}
          label={email}
          tone="synced"
          removing={disconnectingEmail === email}
          onRemove={() => onGmailDisconnect(email)}
          removeLabel={`Disconnect ${email}`}
          title="Disconnect Gmail account"
        />
      ))}
    </div>
  );
}

function GmailRow({
  connectedIntegrations,
  connectingProvider,
  disconnectingEmail,
  onGmailConnect,
  onGmailDisconnect,
}: {
  connectedIntegrations: ConnectedIntegration[];
  connectingProvider: 'gmail' | null;
  disconnectingEmail: string | null;
  onGmailConnect: () => void;
  onGmailDisconnect: (email: string) => void;
}) {
  const isConnected = connectedIntegrations.some((i) => i.name === 'gmail');
  return (
    <div className="px-4 py-2 flex items-center justify-between border-b border-border/50">
      <div className="flex items-center gap-3">
        <DropdownIconFrame {...DropdownIconPreset.gmail} isSynced={isConnected}>
          <GmailIcon />
        </DropdownIconFrame>
        <div className="flex min-w-0 flex-col">
          <div className="flex min-w-0 items-center">
            <span className="truncate text-sm">Gmail</span>
          </div>
          <GmailEmails
            connectedIntegrations={connectedIntegrations}
            disconnectingEmail={disconnectingEmail}
            onGmailDisconnect={onGmailDisconnect}
          />
        </div>
      </div>
      <button
        onClick={onGmailConnect}
        disabled={connectingProvider === 'gmail'}
        className="h-8 w-8 rounded-md flex items-center justify-center transition-all duration-200 bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground disabled:opacity-60"
      >
        {connectingProvider === 'gmail' ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <Plus className="w-3.5 h-3.5" />
        )}
      </button>
    </div>
  );
}

export default function MessagesSyncSection({
  expanded,
  onToggle,
  isIMessageAvailable,
  iMessageSynced,
  whatsAppConnected,
  messageSyncLoading,
  onIMessageSync,
  connectedIntegrations,
  connectingProvider,
  disconnectingEmail,
  onGmailConnect,
  onGmailDisconnect,
}: MessagesSyncSectionProps) {
  const anyMessageConnected =
    iMessageSynced || whatsAppConnected || connectedIntegrations.some((i) => i.name === 'gmail');
  return (
    <div className="rounded-lg border border-border bg-card/60 overflow-hidden">
      <div className="p-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <DropdownIconFrame {...DropdownIconPreset.messagesMain} isSynced={anyMessageConnected}>
            <ChatSyncIcon />
          </DropdownIconFrame>
          <div className="flex flex-col">
            <h3 className="font-medium">Messages</h3>
            <span className="text-xs text-muted-foreground">Sync messaging clients</span>
          </div>
        </div>
        <SectionToggleButton isConnected={anyMessageConnected} onClick={onToggle} />
      </div>
      {expanded && (
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
            onGmailConnect={onGmailConnect}
            onGmailDisconnect={onGmailDisconnect}
          />
          <WhatsAppRow connected={whatsAppConnected} />
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
      )}
    </div>
  );
}
