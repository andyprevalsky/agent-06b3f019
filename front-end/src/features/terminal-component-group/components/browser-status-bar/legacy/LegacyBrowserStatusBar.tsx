/**
 * STATE MACHINE: LegacyBrowserStatusBar — the stock (pre–Rose Desktop) browser
 * chip with the portaled fullscreen view, kept for accounts without the Rose
 * Desktop flag (lib/roseDesktop.ts). Rose Desktop accounts use BrowserStatusBar's
 * Browser-drawer path instead. Remove with the flag.
 *
 *
 * EXPANSION STATE:
 * [COLLAPSED] <-- isExpanded: false
 *     |
 *     | (click to expand)
 *     v
 * [EXPANDED] <-- isExpanded: true
 *     |
 *     | (click to collapse)
 *     v
 * [COLLAPSED]
 *
 * FULLSCREEN STATE:
 * [NORMAL] <-- isFullscreen: false
 *     |
 *     | (click fullscreen button)
 *     v
 * [FULLSCREEN] <-- isFullscreen: true (renders via portal)
 *     |
 *     | (click close or Escape)
 *     v
 * [NORMAL]
 *
 * Orchestrator responsibilities:
 *   - Derives the view-model via useBrowserStatusBarState.
 *   - Owns UI flags + handlers via useBrowserStatusBarUi.
 *   - Dispatches to the three presentational variants (Minimized / Expanded /
 *     Fullscreen) based on current state + forceMinimized prop.
 *
 * AGENT ACTIVITY STATE:
 * [ACTIVE] <-- no pending auth assistance and no disconnect
 *     |
 *     | (requestUserAuthentication IN_PROGRESS message arrives)
 *     v
 * [WAITING_FOR_AUTH_ASSISTANCE] <-- pendingAuthAssistance != null
 *     |
 *     | (user clicks Start Agent / auth assistance completes)
 *     v
 * [ACTIVE]
 *
 * [DISCONNECTED] is derived separately from a session_paused browser message.
 *
 * LIVE VIEW URL (useBrowserSessionBinding):
 * [TRANSCRIPT_URL] --GET .../live-view on mount / transcript change / focus,
 *                    BROWSER_SESSION broadcast on rebind / pause / close-->
 * [BOUND_URL] BrowserSession.debugUrl (rebound + broadcast before the old
 *   provider session is released). Auth handoff shows the interactive bound
 *   URL once a binding is known; user control shows the interactive bound URL.
 *   live=false (closed / provider ended) -> LiveViewLoading instead of iframe;
 *   each new URL shows LiveViewLoading until its iframe loads.
 *
 * TAKE CONTROL (same live session, no reinjection):
 * [AGENT] --Take control--> POST /control {mode:user} --> USER immediately
 * [INSPECTION] -> view-only iframe, no control recovery or mutation controls
 *     |                        (same debugUrl / sessionId)
 *     |                        leftover requested / agent is NOT interactive
 *     v
 * [USER_CONTROLLING] iframe flips interactive=true only when state === user
 *     |
 *     | Hand back
 *     v
 * [AGENT]
 */

import { memo } from 'react';
import { useAgentContext } from '../../../hooks';
import { BrowserStatusBarExpanded } from '../BrowserStatusBarExpanded';
import { BrowserStatusBarFullscreen } from './BrowserStatusBarFullscreen';
import { BrowserStatusBarMinimized } from './BrowserStatusBarMinimized';
import { resolveBrowserControlState } from '../../browserControlState';
import { useBrowserStatusBarState } from '../useBrowserStatusBarState';
import { type BrowserStatusBarUi, useBrowserStatusBarUi } from './useBrowserStatusBarUi';
import { useRefreshedAuthAssistanceUrl } from '../useRefreshedAuthAssistanceUrl';
import type { BrowserStatusBarProps, PendingAuthAssistance } from '../types';
import { isFinishedAgentStatus } from '../liveViewDisplay';

function presentedControlState(
  isUserControlling: boolean,
  isDisconnected: boolean,
  isWaitingForAuthAssistance: boolean,
) {
  return isUserControlling
    ? 'active'
    : resolveBrowserControlState({ isDisconnected, isWaitingForAuthAssistance });
}

/** What the live view's primary control does in the current control state. */
function controlActionFor(
  ui: BrowserStatusBarUi,
  pendingAuthAssistance: PendingAuthAssistance | null,
  controlState: ReturnType<typeof presentedControlState>,
  { isDisconnected }: { isDisconnected: boolean },
): () => void {
  if (ui.isUserControlling) return ui.onHandBackControl;
  if (controlState === 'waiting') {
    return () => {
      if (pendingAuthAssistance) ui.onCompleteAuthAssistance(pendingAuthAssistance.requestId);
    };
  }
  return () => ui.onTakeControl(isDisconnected);
}

function BrowserStatusBarImpl(props: BrowserStatusBarProps) {
  const { taskId, browserUrl, forceMinimized = false } = props;
  const { agent, messages, selectedAgentId } = useAgentContext();
  const agentId = agent?.agent_id ?? selectedAgentId ?? null;
  const vm = useBrowserStatusBarState(taskId);
  const refreshedAuthUrl = useRefreshedAuthAssistanceUrl(
    vm.readOnly ? null : vm.pendingAuthAssistance,
  );
  const handoffBrowserUrl = refreshedAuthUrl ?? vm.pendingAuthAssistance?.liveViewUrl ?? null;
  const ui = useBrowserStatusBarUi(
    taskId,
    forceMinimized,
    agentId,
    browserUrl,
    handoffBrowserUrl,
    vm.readOnly,
  );
  const sharedViewProps = {
    browserUrl: ui.browserUrl,
    browserLive: ui.isLive,
    browserEnded: isFinishedAgentStatus(agent?.status),
    outputSchema: vm.outputSchema,
    browserSessionMetadata: vm.browserSessionMetadata,
  };
  const isWaitingForAuthAssistance = vm.pendingAuthAssistance !== null && !ui.hasReconnected;
  const isDisconnected = vm.isDisconnected && !ui.hasReconnected;
  const controlState = presentedControlState(
    ui.isUserControlling,
    isDisconnected,
    isWaitingForAuthAssistance,
  );
  const handleControlAction = controlActionFor(ui, vm.pendingAuthAssistance, controlState, {
    isDisconnected,
  });

  if (ui.isFullscreen) {
    return (
      <BrowserStatusBarFullscreen
        readOnly={vm.readOnly}
        agentId={agentId}
        taskId={taskId}
        {...sharedViewProps}
        messages={messages}
        stepProgress={vm.stepProgress}
        isDisconnected={isDisconnected}
        isWaitingForAuthAssistance={isWaitingForAuthAssistance}
        authAssistanceRequest={vm.pendingAuthAssistance?.request}
        isResuming={ui.isResuming}
        isUserControlling={ui.isUserControlling}
        pendingWriteLockApproval={vm.readOnly ? null : vm.pendingWriteLockApproval}
        onClose={ui.onFullscreenClose}
        onResume={handleControlAction}
      />
    );
  }

  if (!ui.isExpanded) {
    return (
      <BrowserStatusBarMinimized
        {...sharedViewProps}
        forceMinimized={forceMinimized}
        lastActionType={vm.lastActionType}
        lastActionTitle={vm.lastActionTitle}
        controlState={controlState}
        onExpand={ui.onExpand}
        onThumbnailClick={ui.onThumbnailClick}
        onFullscreenClick={ui.onFullscreenToggle}
      />
    );
  }

  return (
    <BrowserStatusBarExpanded
      taskId={taskId}
      {...sharedViewProps}
      isDisconnected={isDisconnected}
      isWaitingForAuthAssistance={isWaitingForAuthAssistance}
      stepProgress={vm.stepProgress}
      onThumbnailClick={ui.onThumbnailClick}
      onFullscreenToggle={ui.onFullscreenToggle}
      onCollapse={ui.onCollapse}
    />
  );
}

export const LegacyBrowserStatusBar = memo(BrowserStatusBarImpl);
