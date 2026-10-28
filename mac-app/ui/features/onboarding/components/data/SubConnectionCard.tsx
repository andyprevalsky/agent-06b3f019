/**
 * STATE MACHINE: SubConnectionCard (per row)
 *
 * [IDLE] --plus click--> [LOADING] --success--> [CONNECTED]
 * [COMING_SOON] (static)
 *
 * System context:
 *   OnboardingData -> SubConnectionCard: the active ring category's
 *   sub-connections, styled like the integrations page rows (Plus buttons via
 *   the SyncItemButton pattern, DropdownIconFrame icons with a rose glow).
 *   Icons render grey until connected, then regain their brand colors.
 */

import { Check, Loader2, Plus } from 'lucide-react';
import type { JSX, ReactNode } from 'react';

import ConnectedAccountChip from '@/features/integrations/components/ConnectedAccountChip';
import { roseIconGlowGradient } from '@/components/ui/liquidMetalBorder';
import DropdownIconFrame from '@/features/integrations/components/DropdownIconFrame';

export type SubRowState = 'idle' | 'loading' | 'connected' | 'coming-soon';

export interface SubRowModel {
  key: string;
  label: string;
  icon: ReactNode;
  iconScale?: number;
  iconFit?: 'contain' | 'cover' | 'fill';
  state: SubRowState;
  onConnect?: () => void;
  /** e.g. connected Gmail addresses or bank names, shown under the label. */
  chips?: string[];
}

interface SubConnectionCardProps {
  rows: SubRowModel[];
  emptyText?: string;
  footerError?: string | null;
}

function RowAction({ row }: { row: SubRowModel }): JSX.Element {
  if (row.state === 'coming-soon') {
    return <span className="text-xs text-muted-foreground italic">Coming soon</span>;
  }
  const isLoading = row.state === 'loading';
  const isConnected = row.state === 'connected';
  const idleClasses = 'bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground';
  const connectedClasses = 'bg-[#FD5776]/10 text-[#E062CC]';
  return (
    <button
      type="button"
      aria-label={isConnected ? `${row.label} connected` : `Connect ${row.label}`}
      onClick={row.onConnect}
      disabled={isLoading || isConnected}
      className={`h-8 w-8 rounded-md flex items-center justify-center transition-all duration-200 ${
        isConnected ? connectedClasses : idleClasses
      }`}
    >
      {isLoading ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
      ) : isConnected ? (
        <Check className="w-3.5 h-3.5" />
      ) : (
        <Plus className="w-3.5 h-3.5" />
      )}
    </button>
  );
}

function SubRow({ row, isLast }: { row: SubRowModel; isLast: boolean }): JSX.Element {
  const isConnected = row.state === 'connected';
  return (
    <div
      className={`px-4 py-2 flex items-center justify-between${
        isLast ? '' : ' border-b border-border/50'
      }`}
    >
      <div className="flex items-center gap-3">
        <DropdownIconFrame
          iconScale={row.iconScale}
          iconFit={row.iconFit}
          isSynced={isConnected}
          glowGradient={roseIconGlowGradient}
        >
          <span
            className="onb-sub-icon flex items-center justify-center"
            data-synced={String(isConnected)}
          >
            {row.icon}
          </span>
        </DropdownIconFrame>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm text-foreground">{row.label}</span>
          {row.chips !== undefined && row.chips.length > 0 && (
            <div className="mt-1 flex min-w-0 flex-wrap gap-1.5">
              {row.chips.map((chip) => (
                <ConnectedAccountChip key={chip} label={chip} tone="synced" />
              ))}
            </div>
          )}
        </div>
      </div>
      <RowAction row={row} />
    </div>
  );
}

export default function SubConnectionCard({
  rows,
  emptyText,
  footerError,
}: SubConnectionCardProps): JSX.Element {
  return (
    <div
      data-testid="onboarding-sub-card"
      className="w-full max-h-full overflow-y-auto rounded-xl border border-border bg-card"
    >
      {rows.length === 0 ? (
        <div className="px-4 py-3 text-xs text-muted-foreground">
          {emptyText ?? 'Nothing to connect yet.'}
        </div>
      ) : (
        rows.map((row, i) => <SubRow key={row.key} row={row} isLast={i === rows.length - 1} />)
      )}
      {footerError !== undefined && footerError !== null && footerError !== '' && (
        <div className="px-4 py-2 border-t border-border/50 text-xs text-destructive">
          {footerError}
        </div>
      )}
    </div>
  );
}
