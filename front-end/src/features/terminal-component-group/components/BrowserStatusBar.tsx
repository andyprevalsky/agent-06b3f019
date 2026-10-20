/**
 * STATE MACHINE: BrowserStatusBar
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
 * FLAG: Rose Desktop accounts (lib/roseDesktop.ts) → drawer path below; others →
 * LegacyBrowserStatusBar (stock chip + portaled fullscreen view).
 *
 * BROWSER DRAWER STATE (replaces the old fullscreen view):
 * [INLINE] <-- isInDrawer: false
 *     |
 *     | (click thumbnail / maximize / Open Browser / ?browser-id deep link /
 *     |  navi-open-browser event) -> RoseApps.openAgentBrowser(agent, task)
 *     v
 * [IN_DRAWER] <-- isInDrawer: true. The Browser app drawer slides in on this
 *     |          agent's tab; BrowserAgentPane portals into its slot. The chip
 *     |          stays inline as a thumbnail-less minimized row (one iframe).
 *     | (drawer close / Escape / other tab / maximize again)
 *     v
 * [INLINE]
 *
 * Orchestrator responsibilities:
 *   - Derives the view-model via useBrowserStatusBarState.
 *   - Owns UI flags + handlers via useBrowserStatusBarUi.
 *   - Registers this agent's browser as a drawer tab while mounted.
 *   - Dispatches to the presentational variants (Minimized / Expanded) and
 *     portals BrowserAgentPane into the drawer when this task is shown there.
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

import { memo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useAgentContext, type Message } from '../hooks';
import { BrowserAgentPane } from './browser-status-bar/BrowserAgentPane';
import { BrowserStatusBarExpanded } from './browser-status-bar/BrowserStatusBarExpanded';
import { BrowserStatusBarMinimized } from './browser-status-bar/BrowserStatusBarMinimized';
import { useRoseApps } from './rose-apps/roseAppsState';
import { LegacyBrowserStatusBar } from './browser-status-bar/legacy/LegacyBrowserStatusBar';
import { useRoseDesktop } from '@/hooks/roseDesktopContext';
import { resolveBrowserControlState } from './browserControlState';
import { useBrowserStatusBarState } from './browser-status-bar/useBrowserStatusBarState';
import {
  type BrowserStatusBarUi,
  useBrowserStatusBarUi,
} from './browser-status-bar/useBrowserStatusBarUi';
import { useRefreshedAuthAssistanceUrl } from './browser-status-bar/useRefreshedAuthAssistanceUrl';
import type { BrowserStatusBarProps, PendingAuthAssistance } from './browser-status-bar/types';

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

/** Keep this agent's browser listed as a Browser-drawer tab while mounted. */
function useDrawerTabRegistration(agentId: string | null, taskId: string, live: boolean) {
  const apps = useRoseApps();
  const register = apps?.registerAgentBrowser;
  const unregister = apps?.unregisterAgentBrowser;
  const missing = agentId !== null && apps?.tabs.some((t) => t.agentId === agentId) !== true;
  useEffect(() => {
    if (agentId === null || !register) return;
    register({ agentId, taskId, live });
  }, [agentId, live, missing, register, taskId]);
  useEffect(() => {
    if (agentId === null || !unregister) return undefined;
    return () => unregister(agentId, taskId);
  }, [agentId, taskId, unregister]);
  return apps?.slot ?? null;
}

/** Session/control props the drawer pane needs beyond the shared view props. */
function drawerPaneState(
  vm: ReturnType<typeof useBrowserStatusBarState>,
  ui: BrowserStatusBarUi,
  messages: Message[],
  isDisconnected: boolean,
  isWaitingForAuthAssistance: boolean,
) {
  return {
    messages,
    stepProgress: vm.stepProgress,
    isDisconnected,
    isWaitingForAuthAssistance,
    authAssistanceRequest: vm.pendingAuthAssistance?.request,
    isResuming: ui.isResuming,
    isUserControlling: ui.isUserControlling,
    pendingWriteLockApproval: vm.readOnly ? null : vm.pendingWriteLockApproval,
  };
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
  const drawerSlot = useDrawerTabRegistration(agentId, taskId, ui.isLive);

  const drawerPane =
    ui.isInDrawer && drawerSlot !== null
      ? createPortal(
          <BrowserAgentPane
            readOnly={vm.readOnly}
            agentId={agentId}
            taskId={taskId}
            {...sharedViewProps}
            {...drawerPaneState(vm, ui, messages, isDisconnected, isWaitingForAuthAssistance)}
            onResume={handleControlAction}
          />,
          drawerSlot,
        )
      : null;

  const inline =
    ui.isInDrawer || !ui.isExpanded ? (
      <BrowserStatusBarMinimized
        {...sharedViewProps}
        forceMinimized={forceMinimized}
        showThumbnail={!ui.isInDrawer}
        lastActionType={vm.lastActionType}
        lastActionTitle={vm.lastActionTitle}
        controlState={controlState}
        onExpand={ui.onExpand}
        onThumbnailClick={ui.onThumbnailClick}
        onFullscreenClick={ui.onDrawerToggle}
      />
    ) : (
      <BrowserStatusBarExpanded
        taskId={taskId}
        {...sharedViewProps}
        isDisconnected={isDisconnected}
        isWaitingForAuthAssistance={isWaitingForAuthAssistance}
        stepProgress={vm.stepProgress}
        onThumbnailClick={ui.onThumbnailClick}
        onFullscreenToggle={ui.onDrawerToggle}
        onCollapse={ui.onCollapse}
      />
    );

  return (
    <>
      {inline}
      {drawerPane}
    </>
  );
}

/** Rose Desktop accounts get the Browser drawer; everyone else keeps the stock fullscreen view. */
function BrowserStatusBarSwitch(props: BrowserStatusBarProps) {
  return useRoseDesktop() ? (
    <BrowserStatusBarImpl {...props} />
  ) : (
    <LegacyBrowserStatusBar {...props} />
  );
}

const BrowserStatusBar = memo(BrowserStatusBarSwitch);
export default BrowserStatusBar;
