/**
 * STATE MACHINE: BrowserProxyLocationChip
 *
 * DATA STATE:
 * [NO_METADATA] -> returns null
 * [HAS_METADATA] -> renders icon chip
 *
 * HOVER STATE:
 * [IDLE] -- hover/focus --> [TOOLTIP_VISIBLE] -- leave/blur --> [IDLE]
 *
 * Feature context:
 * Browser session metadata -> useBrowserStatusBarState -> BrowserProxyLocationChip
 * The chip is presentational only; it never mutates browser/session state.
 */

import { MapPin } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { BrowserProxyLocation, BrowserSessionMetadata } from './types';

interface BrowserProxyLocationChipProps {
  metadata: BrowserSessionMetadata | null;
  className?: string;
  routing?: 'local' | 'remote';
  bare?: boolean;
  tooltipPosition?: 'top' | 'bottom' | 'left' | 'right';
}

function humanizeProxySource(source: string | undefined): string {
  if (!source) return 'Unknown';
  if (source.toLowerCase() === 'byop') return 'BYOP';
  if (source === 'browser_use_residential_country') return 'Browser Use residential (country)';
  return source.charAt(0).toUpperCase() + source.slice(1);
}

function formatLocation(location: BrowserProxyLocation | undefined): string | null {
  if (!location) return null;
  const parts = [location.city, location.state, location.country].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
}

export function BrowserProxyLocationChip({
  metadata,
  className,
  routing,
  bare = false,
  tooltipPosition = 'bottom',
}: BrowserProxyLocationChipProps) {
  if (!metadata && !routing) return null;

  const proxySource = metadata?.proxy_source ?? metadata?.proxySource;
  const location = metadata?.proxy_location ?? metadata?.proxyLocation;
  const locationLabel = formatLocation(location);
  if (!proxySource && !locationLabel && !routing) return null;
  const routeLabel =
    routing === 'local'
      ? 'Traffic is routed through your local computer.'
      : !proxySource && !locationLabel
        ? 'Remote browser proxy location is not available yet.'
        : undefined;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          title={routeLabel}
          className={cn(
            'inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
            !bare && 'border border-border bg-background/70',
            className,
          )}
          aria-label="Browser proxy location"
        >
          <MapPin className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent side={tooltipPosition} className="max-w-[240px]">
        <div className="space-y-0.5 text-xs leading-5">
          {routeLabel ? (
            <div>{routeLabel}</div>
          ) : (
            <>
              <div>Proxy: {humanizeProxySource(proxySource)}</div>
              {locationLabel && <div>Location: {locationLabel}</div>}
            </>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
