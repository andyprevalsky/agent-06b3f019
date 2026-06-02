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
  tooltipPosition?: 'top' | 'bottom' | 'left' | 'right';
}

function humanizeProxySource(source: string | undefined): string {
  if (!source) return 'Unknown';
  if (source.toLowerCase() === 'byop') return 'BYOP';
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
  tooltipPosition = 'bottom',
}: BrowserProxyLocationChipProps) {
  if (!metadata) return null;

  const proxySource = metadata.proxy_source ?? metadata.proxySource;
  const location = metadata.proxy_location ?? metadata.proxyLocation;
  const locationLabel = formatLocation(location);
  if (!proxySource && !locationLabel) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            'inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md border border-border bg-background/70 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
            className,
          )}
          aria-label="Browser proxy location"
        >
          <MapPin className="h-3.5 w-3.5" />
        </div>
      </TooltipTrigger>
      <TooltipContent side={tooltipPosition} className="max-w-[240px]">
        <div className="space-y-0.5 text-xs leading-5">
          <div>Proxy: {humanizeProxySource(proxySource)}</div>
          {locationLabel && <div>Location: {locationLabel}</div>}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
