/**
 * STATE MACHINE: GranolaSection
 *
 *   [DISCONNECTED] --plus--> [SIGNING_IN] (Granola sign-in page; useGranola)
 *     --signed in--> [CONNECTED (syncing history)] --backfill done--> [CONNECTED]
 *   [CONNECTED] --sync--> [SYNCING] --done--> [CONNECTED]
 *   [EXPIRED] --"Reconnect"--> [SIGNING_IN]
 *   [CONNECTED] --chip remove--> [DISCONNECTING] --done--> [DISCONNECTED]
 *
 * Granola meetings (notes, summaries, transcripts) sync server-side into the
 * grep document store; this card only starts sign-in and shows sync status.
 */

import { Loader2, Plus, RefreshCw } from 'lucide-react';

import ConnectedAccountChip from './ConnectedAccountChip';
import type { useGranola } from '../hooks/useGranola';

interface GranolaSectionProps {
  granola: ReturnType<typeof useGranola>;
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

function detailText(granola: GranolaSectionProps['granola']): string {
  const { status } = granola;
  if (status === null) return 'Loading...';
  if (granola.busy === 'connect') return 'Finish signing in to Granola...';
  if (!status.connected) return 'Search your meeting notes, summaries and transcripts';
  if (status.status === 'EXPIRED') return 'Granola sign-in expired. Reconnect to keep syncing.';
  if (status.status === 'SYNC_FAILED') return `Last sync failed: ${status.lastError ?? 'unknown'}`;
  const meetings = status.documents.granola_note ?? 0;
  const synced = `${meetings} meeting${meetings === 1 ? '' : 's'} synced`;
  return status.backfillDone ? synced : `${synced}, importing older meetings...`;
}

export default function GranolaSection({ granola }: GranolaSectionProps) {
  const status = granola.status;
  const connected = status?.connected === true;
  const expired = status?.status === 'EXPIRED';
  const syncing = status?.status === 'SYNCING' || granola.busy === 'sync';
  return (
    <div className="rounded-lg border border-border bg-card/60 overflow-hidden">
      <div className="p-4 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="h-9 w-9 shrink-0 overflow-hidden rounded-lg">
            <GranolaIcon />
          </div>
          <div className="flex min-w-0 flex-col">
            <h3 className="font-medium">Granola</h3>
            <span className="text-xs text-muted-foreground">{detailText(granola)}</span>
            {connected && (
              <div className="mt-1 flex flex-wrap items-center gap-1">
                <ConnectedAccountChip
                  label={status.accountEmail ?? 'Granola'}
                  tone={expired ? 'warning' : syncing ? 'syncing' : 'synced'}
                  removing={granola.busy === 'disconnect'}
                  disabled={granola.busy !== null}
                  onRemove={() => void granola.disconnect()}
                  removeLabel="Disconnect Granola and delete its synced notes"
                  title="Disconnect Granola"
                />
              </div>
            )}
            {granola.error !== null && (
              <span className="text-xs text-destructive">{granola.error}</span>
            )}
          </div>
        </div>
        {connected && !expired ? (
          <button
            type="button"
            aria-label="Sync Granola now"
            onClick={() => void granola.sync()}
            disabled={granola.busy !== null || syncing}
            className="h-9 w-9 rounded-lg flex items-center justify-center bg-muted text-muted-foreground hover:text-foreground disabled:opacity-60"
          >
            <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
          </button>
        ) : (
          <button
            type="button"
            aria-label={expired ? 'Reconnect Granola' : 'Connect Granola'}
            onClick={() => void granola.connect()}
            disabled={granola.busy !== null || status === null}
            className="h-9 w-9 rounded-lg flex items-center justify-center bg-foreground text-background hover:bg-foreground/90 disabled:opacity-60"
          >
            {granola.busy === 'connect' ? (
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
