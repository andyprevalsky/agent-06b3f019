/**
 * STATE MACHINE: MessagesSyncSection
 *
 * [COLLAPSED] --toggle--> [EXPANDED] --toggle--> [COLLAPSED]
 *
 * Sub-items:
 *   iMessage: [IDLE] --click--> [SYNCING] --done--> [SYNCED]  (Desktop only)
 *   Gmail:    [IDLE] --click--> [CONNECTING] --OAuth--> [CONNECTED]
 *   WhatsApp, Telegram, Messenger: [COMING_SOON] (static)
 */

import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

import type { ConnectedIntegration, MessageSyncType } from '../types';
import ConnectedStatusText from './ConnectedStatusText';
import DropdownIconFrame, { dropdownIconPreset } from './DropdownIconFrame';
import SectionToggleButton from './SectionToggleButton';
import SyncItemButton from './SyncItemButton';

interface MessagesSyncSectionProps {
  expanded: boolean;
  onToggle: () => void;
  isIMessageAvailable: boolean;
  iMessageSynced: boolean;
  messageSyncLoading: MessageSyncType | null;
  onIMessageSync: () => void;
  connectedIntegrations: ConnectedIntegration[];
  connectingProvider: 'gmail' | null;
  onGmailConnect: () => void;
}

function IMessageIcon({ gradientId }: { gradientId: string }) {
  return (
    <svg className="w-6 h-6" viewBox="0 0 24 24">
      <defs>
        <linearGradient id={gradientId} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#5bf675" />
          <stop offset="100%" stopColor="#1fcc3f" />
        </linearGradient>
      </defs>
      <rect width="24" height="24" rx="5" fill={`url(#${gradientId})`} />
      <path
        fill="white"
        d="M12 5C7.58 5 4 8.13 4 12c0 1.65.67 3.15 1.76 4.35L5 19l2.88-.93C9.05 18.66 10.48 19 12 19c4.42 0 8-3.13 8-7s-3.58-7-8-7z"
      />
    </svg>
  );
}

function GmailIcon() {
  return (
    <svg className="w-6 h-6" viewBox="0 0 24 24">
      <path
        fill="#EA4335"
        d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z"
      />
    </svg>
  );
}

function ChatSyncIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" role="img" aria-label="Messages icon">
      <defs>
        <linearGradient id="chatSyncGradient" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#34d399" />
          <stop offset="100%" stopColor="#10b981" />
        </linearGradient>
      </defs>
      <path
        fill="url(#chatSyncGradient)"
        transform="translate(24 0) scale(-1 1)"
        d="M20 2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14l4 4V4c0-1.1-.9-2-2-2z"
      />
    </svg>
  );
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

function WhatsAppIcon() {
  return (
    <svg className="w-6 h-6" viewBox="0 0 24 24">
      <rect width="24" height="24" rx="5" fill="#25D366" />
      <path
        fill="white"
        d="M12 4c-4.42 0-8 3.58-8 8 0 1.41.37 2.73 1.01 3.88L4 20l4.26-1.12A7.93 7.93 0 0 0 12 20c4.42 0 8-3.58 8-8s-3.58-8-8-8zm4.14 11.07c-.17.48-1 .93-1.38.99-.37.06-.84.09-1.35-.09-.31-.11-.71-.25-1.23-.49-2.16-1-3.57-3.18-3.68-3.33-.1-.15-.86-1.14-.86-2.18s.55-1.55.74-1.76c.2-.21.43-.27.57-.27h.42c.13 0 .31-.05.48.37.18.43.61 1.49.66 1.59.05.1.08.22.02.35-.07.14-.1.22-.2.34-.1.12-.21.26-.3.35-.1.1-.2.2-.09.4.12.2.53.87 1.13 1.41.78.7 1.43.91 1.63 1.02.2.1.32.09.44-.06.12-.14.5-.58.64-.78.13-.2.27-.16.45-.1.18.07 1.15.54 1.34.64.2.1.33.15.38.23.05.09.05.51-.12.99z"
      />
    </svg>
  );
}

function TelegramIcon() {
  return (
    <svg className="w-6 h-6" viewBox="0 0 24 24">
      <rect width="24" height="24" rx="5" fill="#229ED9" />
      <path
        fill="white"
        d="M5.5 11.5l10.7-4.3c.6-.24 1.1.12.9.92l-1.9 9c-.14.64-.52.8-1.06.5l-2.9-2.1-1.4 1.4c-.12.1-.2.2-.4.2-.26 0-.37-.15-.5-.52l-1.1-3.5-2.7-.84c-.32-.11-.34-.41.06-.56zm4.7 1.7l.6 2.55.17-1.85 4.5-4c.2-.18-.05-.27-.32-.1l-5.5 3.4z"
        transform="translate(12, 12) scale(1.05) translate(-12, -12)"
      />
    </svg>
  );
}

function MessengerIcon() {
  return (
    <svg className="w-6 h-6" viewBox="0 0 24 24">
      <defs>
        <linearGradient id="messengerGrad" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#00B2FF" />
          <stop offset="100%" stopColor="#006AFF" />
        </linearGradient>
      </defs>
      <rect width="24" height="24" rx="5" fill="url(#messengerGrad)" />
      <path
        fill="white"
        d="M12 4c-4.42 0-8 3.13-8 7 0 2.2 1.1 4.16 2.8 5.45V19l2.4-1.32c.64.18 1.32.27 2.03.27h.77c4.42 0 8-3.13 8-7s-3.58-7-8-7zm.8 9.43l-2.04-2.17-3.98 2.17 4.37-4.64 2.09 2.17 3.93-2.17-4.37 4.64z"
        transform="scale(0.85) translate(2.1, 2.1)"
      />
    </svg>
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
          <DropdownIconFrame {...dropdownIconPreset.imessage} isSynced={synced}>
            <IMessageIcon gradientId="imessageGrad" />
          </DropdownIconFrame>
          <div className="flex flex-col items-start">
            <span className="text-sm">iMessage</span>
            <ConnectedStatusText isConnected={synced} />
          </div>
        </div>
        <SyncItemButton isLoading={loading === 'imessage'} isSynced={synced} onClick={onSync} />
      </div>
    );
  }
  return (
    <div className="px-4 py-2 flex items-center justify-between flex-wrap gap-2 border-b border-border/50">
      <div className="flex items-center gap-3">
        <DropdownIconFrame {...dropdownIconPreset.imessage}>
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

function GmailEmails({ connectedIntegrations }: { connectedIntegrations: ConnectedIntegration[] }) {
  const gmail = connectedIntegrations.find((i) => i.name === 'gmail');
  const emails =
    gmail?.config?.connectedEmails ||
    (gmail?.config?.connectedEmail ? [gmail.config.connectedEmail] : []);
  if (emails.length === 0) return null;

  return (
    <div className="mt-0.5 flex min-w-0 flex-col">
      {(emails as string[]).map((email: string) => (
        <span key={email} className="truncate text-xs text-muted-foreground">
          {email}
        </span>
      ))}
    </div>
  );
}

function GmailRow({
  connectedIntegrations,
  connectingProvider,
  onGmailConnect,
}: {
  connectedIntegrations: ConnectedIntegration[];
  connectingProvider: 'gmail' | null;
  onGmailConnect: () => void;
}) {
  const isConnected = connectedIntegrations.some((i) => i.name === 'gmail');
  return (
    <div className="px-4 py-2 flex items-center justify-between border-b border-border/50">
      <div className="flex items-center gap-3">
        <DropdownIconFrame {...dropdownIconPreset.gmail} isSynced={isConnected}>
          <GmailIcon />
        </DropdownIconFrame>
        <div className="flex min-w-0 flex-col">
          <span className="text-sm">Gmail</span>
          <ConnectedStatusText isConnected={isConnected} />
          <GmailEmails connectedIntegrations={connectedIntegrations} />
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
          <svg
            className="w-3.5 h-3.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
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
  messageSyncLoading,
  onIMessageSync,
  connectedIntegrations,
  connectingProvider,
  onGmailConnect,
}: MessagesSyncSectionProps) {
  const anyMessageConnected =
    iMessageSynced || connectedIntegrations.some((i) => i.name === 'gmail');
  return (
    <div className="rounded-lg border border-border bg-card/60 overflow-hidden">
      <div className="p-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <DropdownIconFrame {...dropdownIconPreset.messagesMain} isSynced={anyMessageConnected}>
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
            onGmailConnect={onGmailConnect}
          />
          <ComingSoonRow
            icon={<WhatsAppIcon />}
            iconFrameProps={dropdownIconPreset.whatsapp}
            label="WhatsApp"
          />
          <ComingSoonRow
            icon={<TelegramIcon />}
            iconFrameProps={dropdownIconPreset.telegram}
            label="Telegram"
          />
          <ComingSoonRow
            icon={<MessengerIcon />}
            iconFrameProps={dropdownIconPreset.messenger}
            label="Messenger"
            borderBottom={false}
          />
        </div>
      )}
    </div>
  );
}
