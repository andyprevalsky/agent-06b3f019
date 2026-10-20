/**
 * STATE MACHINE: InlineUserView (message.metadata.inlineView)
 *
 *   [LOADING]   pinned version's manifest not resolved yet → "Loading view…"
 *   [UNAVAILABLE] version/view missing                    → summary or notice
 *   [STATIC]    safe mode, offscreen, or over the live cap → poster <img> if the
 *               view has one, else its summary text
 *   [LIVE]      near viewport + lease from the live cap (default 4) →
 *               sandboxed frame on usercontent/<pinned versionId>/, height from
 *               rose:resize clamped 60..900px
 *   [EXPANDED]  expand button → same frame fills the viewport (no reload);
 *               close button / Escape → [LIVE]
 *
 *   [STATIC] --scrolls near + lease--> [LIVE] --scrolls away--> [STATIC]
 *
 * The version comes from the message, never the active pointer, so a later
 * publish cannot change how an older message renders.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

import { clampInlineHeight, INLINE_VIEW_DEFAULT_HEIGHT } from '../config';
import {
  useInlineLiveLease,
  useInlineViewFiles,
  useNearViewport,
  useUserUi,
  type ResolvedInlineView,
} from '../hooks';
import type { InlineViewMetadata } from '../types';
import { UserUiFrame } from './UserUiFrame';

interface InlineUserViewProps {
  inlineView: InlineViewMetadata;
  messageId: string;
}

function InlineViewFallback({ files, view }: { files: ResolvedInlineView; view: string }) {
  if (files.posterUrl) {
    return (
      <img
        data-testid="user-ui-inline-poster"
        src={files.posterUrl}
        alt={files.summary ?? view}
        className="block max-h-[480px] w-full object-contain"
      />
    );
  }
  const text =
    files.summary ??
    (files.status === 'loading' ? 'Loading view…' : `Interactive view “${view}” is unavailable`);
  return (
    <p data-testid="user-ui-inline-summary" className="px-4 py-3 text-sm text-muted-foreground">
      {text}
    </p>
  );
}

function useEscapeToClose(expanded: boolean, close: () => void) {
  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [expanded, close]);
}

export function InlineUserView({ inlineView, messageId }: InlineUserViewProps) {
  const { active, safeMode, liveCap } = useUserUi();
  const files = useInlineViewFiles(inlineView, active);
  const containerRef = useRef<HTMLDivElement>(null);
  const near = useNearViewport(containerRef);
  const [expanded, setExpanded] = useState(false);
  const [height, setHeight] = useState(INLINE_VIEW_DEFAULT_HEIGHT);
  const live = useInlineLiveLease(
    liveCap,
    messageId,
    !safeMode && files.src !== null && (near || expanded),
  );
  const showFrame = live && files.src !== null;
  const close = useCallback(() => setExpanded(false), []);
  useEscapeToClose(expanded, close);

  return (
    <div
      ref={containerRef}
      data-testid="user-ui-inline-view"
      data-inline-view={inlineView.view}
      data-inline-version={inlineView.versionId}
      data-inline-state={showFrame ? (expanded ? 'expanded' : 'live') : 'static'}
      className={cn(
        expanded
          ? 'fixed inset-0 z-[100] flex flex-col bg-background p-4'
          : 'relative my-2 w-full overflow-hidden rounded-xl border border-border bg-white',
      )}
    >
      {showFrame && files.src ? (
        <>
          <UserUiFrame
            src={files.src}
            title={files.summary ?? inlineView.view}
            props={inlineView.props}
            onResize={(next) => setHeight(clampInlineHeight(next))}
            testId="user-ui-inline-frame"
            className={cn('block w-full', expanded && 'flex-1')}
            style={expanded ? undefined : { height }}
          />
          <button
            type="button"
            data-testid="user-ui-inline-expand"
            aria-label={expanded ? 'Close full screen view' : 'Expand view to full screen'}
            onClick={() => setExpanded(!expanded)}
            className="absolute right-2 top-2 rounded-md border border-gray-200 bg-white/90 px-2 py-0.5 text-xs text-gray-700 shadow-sm"
          >
            {expanded ? 'Close' : 'Expand'}
          </button>
        </>
      ) : (
        <InlineViewFallback files={files} view={inlineView.view} />
      )}
    </div>
  );
}
