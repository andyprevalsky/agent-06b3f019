/**
 * STATE MACHINE: MeetingNotesProviderCard
 *
 *   [DISCONNECTED] --plus--> [SIGNING_IN] (provider sign-in page; useMeetingNotes)
 *     --signed in--> [CONNECTED (syncing history)] --backfill done--> [CONNECTED]
 *   [CONNECTED] --sync--> [SYNCING] --done--> [CONNECTED]
 *   [EXPIRED] --"Reconnect"--> [SIGNING_IN]
 *   [CONNECTED] --chip remove--> [DISCONNECTING] --done--> [DISCONNECTED]
 *
 * Provider meetings (notes, summaries, transcripts) sync server-side into the
 * grep document store; this card only starts sign-in and shows sync status.
 */

import { Loader2, Plus, RefreshCw } from 'lucide-react';

import { meetingNotesDetail } from '../hooks/meetingNotesView';
import ConnectedAccountChip from './ConnectedAccountChip';
import type { useMeetingNotes } from '../hooks/useMeetingNotes';
import { meetingNotesProviders } from '../config';
import type { MeetingNotesProvider } from '../types';

interface MeetingNotesProviderCardProps {
  provider: MeetingNotesProvider;
  connection: ReturnType<typeof useMeetingNotes>;
}

export function GranolaIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-full w-full" aria-hidden="true">
      <rect width="24" height="24" rx="6" fill="#2F3A1F" />
      <path
        d="M16.5 8.2A5 5 0 1 0 17 13h-4.5"
        stroke="#D6F07A"
        strokeWidth="2.2"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

export default function MeetingNotesProviderCard({
  provider,
  connection,
}: MeetingNotesProviderCardProps) {
  const { name, domain } = meetingNotesProviders[provider];
  const status = connection.status;
  const connected = status?.connected === true;
  const expired = status?.status === 'EXPIRED';
  const syncing = status?.status === 'SYNCING' || connection.busy === 'sync';
  return (
    <div className="rounded-lg border border-border bg-card/60 overflow-hidden">
      <div className="p-4 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="h-9 w-9 shrink-0 overflow-hidden rounded-lg">
            <MeetingNotesIcon provider={provider} />
          </div>
          <div className="flex min-w-0 flex-col">
            <h3 className="font-medium">{name}</h3>
            <span className="text-xs text-muted-foreground">{domain}</span>
            <span className="text-xs text-muted-foreground">
              {meetingNotesDetail(connection, provider)}
            </span>
            {connected && (
              <div className="mt-1 flex flex-wrap items-center gap-1">
                <ConnectedAccountChip
                  label={status.accountEmail ?? name}
                  tone={expired ? 'warning' : syncing ? 'syncing' : 'synced'}
                  removing={connection.busy === 'disconnect'}
                  disabled={connection.busy !== null}
                  onRemove={() => void connection.disconnect()}
                  removeLabel={`Disconnect ${name} and delete its synced notes`}
                  title={`Disconnect ${name}`}
                />
              </div>
            )}
            {connection.error !== null && (
              <span className="text-xs text-destructive">{connection.error}</span>
            )}
          </div>
        </div>
        {connected && !expired ? (
          <button
            type="button"
            aria-label={`Sync ${name} now`}
            onClick={() => void connection.sync()}
            disabled={connection.busy !== null || syncing}
            className="h-9 w-9 rounded-lg flex items-center justify-center bg-muted text-muted-foreground hover:text-foreground disabled:opacity-60"
          >
            <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
          </button>
        ) : (
          <button
            type="button"
            aria-label={expired ? `Reconnect ${name}` : `Connect ${name}`}
            onClick={() => void connection.connect()}
            disabled={connection.busy !== null || status === null}
            className="h-9 w-9 rounded-lg flex items-center justify-center bg-foreground text-background hover:bg-foreground/90 disabled:opacity-60"
          >
            {connection.busy === 'connect' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
          </button>
        )}
      </div>
    </div>
  );
}

/** Stateless provider glyphs. */
export function MeetingNotesIcon({ provider }: { provider: MeetingNotesProvider }) {
  if (provider === 'granola') return <GranolaIcon />;
  return (
    <svg viewBox="0 0 24 24" className="h-full w-full" aria-hidden="true">
      <rect width="24" height="24" rx="6" fill="#6639BA" />
      <path
        d="M8 17V7h9M8 12h7"
        stroke="white"
        strokeWidth="2.5"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}
