/**
 * STATE MACHINE: RootBrowserPane (Browser drawer, Root tab; plan row A6)
 *
 *   [LOADING] GET /browser-world/root (only while the drawer is open)
 *   [CLOSED] root null --"Open browser"--> POST /root/open --> [OPENING] --> [LIVE]
 *   [CLOSED + RECEIPT] after a close: "Saved logins for github.com" (6 s), then [CLOSED]
 *   [ERROR] read or open failed --> muted text; "Open browser" retries
 *   [LIVE] Root's live view (useBrowserSessionControl: GET .../live-view binding,
 *          control recovery). View only until the user takes over:
 *            --Take control--> POST .../control {mode:user} --> interactive iframe
 *            --Hand back control--> POST .../control {mode:agent} --> view only
 *          --Close browser--> POST /root/close --> [CLOSED + RECEIPT]
 *          Reload (drawer chrome) remounts the live view (key = reloadKey).
 */

import { Globe } from 'lucide-react';
import type { RootBrowserView } from '@/lib/api/browser-world';
import { TakeControlChip } from '../browser-status-bar/BrowserFullscreenOverlays';
import { LiveViewFrame } from '../browser-status-bar/BrowserLiveViewFrame';
import { useBrowserSessionControl } from '../browser-status-bar/useBrowserStatusBarUi';

const MUTED = 'text-[hsl(240_8%_45%)] dark:text-[#a3a39d]';
const TEXT_ACTION =
  'text-[12.5px] font-medium text-[hsl(240_15%_8%)] underline-offset-2 hover:underline disabled:cursor-default disabled:opacity-50 dark:text-[#ecece8]';

export interface RootBrowserPaneProps {
  loading: boolean;
  root: RootBrowserView | null;
  error: string | null;
  receipt: string | null;
  opening: boolean;
  closing: boolean;
  reloadKey: number;
  onOpen: () => void;
  onClose: () => void;
}

function LiveRootBrowser({
  root,
  closing,
  reloadKey,
  onClose,
}: Pick<RootBrowserPaneProps, 'closing' | 'reloadKey' | 'onClose'> & { root: RootBrowserView }) {
  const control = useBrowserSessionControl(
    root.task_id,
    null,
    root.live_view_url ?? '',
    null,
    false,
  );
  const onControl = control.isUserControlling
    ? control.onHandBackControl
    : () => control.onTakeControl(false);
  return (
    <div data-testid="root-browser-pane" className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none items-center justify-between px-[18px] py-2 text-[12.5px]">
        <span className={MUTED}>
          {control.isUserControlling ? 'You have control' : 'Your browser'}
        </span>
        <button type="button" className={TEXT_ACTION} disabled={closing} onClick={onClose}>
          {closing ? 'Closing…' : 'Close browser'}
        </button>
      </div>
      {control.browserUrl === '' ? (
        <div className={`flex flex-1 items-center justify-center text-xs ${MUTED}`}>
          Connecting…
        </div>
      ) : (
        <LiveViewFrame
          key={reloadKey}
          url={control.browserUrl}
          live={control.isLive}
          title="Root browser"
          interactive={control.isUserControlling}
          iframeKey={`${root.task_id}:${control.browserUrl}`}
          className="flex w-full flex-none flex-col bg-white"
          style={{ aspectRatio: '8 / 5', maxHeight: '68%' }}
        >
          <TakeControlChip
            onResume={onControl}
            isResuming={control.isResuming}
            isUserControlling={control.isUserControlling}
            idleLabel="View only"
          />
        </LiveViewFrame>
      )}
    </div>
  );
}

function ClosedRootBrowser({
  loading,
  error,
  receipt,
  opening,
  onOpen,
}: Pick<RootBrowserPaneProps, 'loading' | 'error' | 'receipt' | 'opening' | 'onOpen'>) {
  return (
    <div
      data-testid="root-browser-empty"
      className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center"
    >
      <Globe className={`h-8 w-8 ${MUTED}`} strokeWidth={1.5} />
      <div className="text-sm font-semibold">Your browser</div>
      <p className={`max-w-xs text-xs ${MUTED}`}>
        Sign in to sites here and every agent can use those logins.
      </p>
      {receipt !== null && (
        <p data-testid="root-browser-receipt" role="status" className={`text-xs ${MUTED}`}>
          {receipt}
        </p>
      )}
      {error !== null && <p className={`text-xs ${MUTED}`}>{error}</p>}
      {!loading && (
        <button type="button" className={TEXT_ACTION} disabled={opening} onClick={onOpen}>
          {opening ? 'Opening…' : 'Open browser'}
        </button>
      )}
    </div>
  );
}

export function RootBrowserPane(props: RootBrowserPaneProps) {
  if (props.root !== null) {
    return (
      <LiveRootBrowser
        root={props.root}
        closing={props.closing}
        reloadKey={props.reloadKey}
        onClose={props.onClose}
      />
    );
  }
  return <ClosedRootBrowser {...props} />;
}
