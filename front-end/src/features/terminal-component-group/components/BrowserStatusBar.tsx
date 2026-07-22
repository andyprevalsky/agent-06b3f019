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
 */

import { memo } from 'react';
import { useAgentContext } from '../hooks';
import { BrowserStatusBarExpanded } from './browser-status-bar/BrowserStatusBarExpanded';
import { BrowserStatusBarFullscreen } from './browser-status-bar/BrowserStatusBarFullscreen';
import { BrowserStatusBarMinimized } from './browser-status-bar/BrowserStatusBarMinimized';
import { resolveBrowserControlState } from './browserControlState';
import { useBrowserStatusBarState } from './browser-status-bar/useBrowserStatusBarState';
import { useBrowserStatusBarUi } from './browser-status-bar/useBrowserStatusBarUi';
import { useRefreshedAuthAssistanceUrl } from './browser-status-bar/useRefreshedAuthAssistanceUrl';
import type { BrowserStatusBarProps } from './browser-status-bar/types';

function presentedControlState(
  isUserControlling: boolean,
  isDisconnected: boolean,
  isWaitingForAuthAssistance: boolean,
) {
  return isUserControlling
    ? 'active'
    : resolveBrowserControlState({ isDisconnected, isWaitingForAuthAssistance });
}

function BrowserStatusBarImpl({
  taskId,
  browserUrl,
  forceMinimized = false,
}: BrowserStatusBarProps) {
  const { agent, messages, selectedAgentId } = useAgentContext();
  const agentId = agent?.agent_id ?? selectedAgentId ?? null;
  const vm = useBrowserStatusBarState(taskId);
  const refreshedAuthUrl = useRefreshedAuthAssistanceUrl(vm.pendingAuthAssistance);
  const sessionBrowserUrl = refreshedAuthUrl ?? vm.pendingAuthAssistance?.liveViewUrl ?? browserUrl;
  const ui = useBrowserStatusBarUi(taskId, forceMinimized, agentId, sessionBrowserUrl);
  const activeBrowserUrl = ui.browserUrl;
  const isWaitingForAuthAssistance = vm.pendingAuthAssistance !== null && !ui.hasReconnected;
  const isDisconnected = vm.isDisconnected && !ui.hasReconnected;
  const controlState = presentedControlState(
    ui.isUserControlling,
    isDisconnected,
    isWaitingForAuthAssistance,
  );
  const handleControlAction = ui.isUserControlling
    ? ui.onHandBackControl
    : controlState === 'waiting'
      ? () => {
          if (vm.pendingAuthAssistance) {
            void ui.onCompleteAuthAssistance(vm.pendingAuthAssistance.requestId);
          }
        }
      : () => ui.onTakeControl(isDisconnected);

  if (ui.isFullscreen) {
    return (
      <BrowserStatusBarFullscreen
        agentId={agentId}
        taskId={taskId}
        browserUrl={activeBrowserUrl}
        messages={messages}
        outputSchema={vm.outputSchema}
        browserSessionMetadata={vm.browserSessionMetadata}
        stepProgress={vm.stepProgress}
        isDisconnected={isDisconnected}
        isWaitingForAuthAssistance={isWaitingForAuthAssistance}
        authAssistanceRequest={vm.pendingAuthAssistance?.request}
        isResuming={ui.isResuming}
        isUserControlling={ui.isUserControlling}
        pendingWriteLockApproval={vm.pendingWriteLockApproval}
        onClose={ui.onFullscreenClose}
        onResume={handleControlAction}
      />
    );
  }

  if (!ui.isExpanded) {
    return (
      <BrowserStatusBarMinimized
        browserUrl={activeBrowserUrl}
        forceMinimized={forceMinimized}
        lastActionType={vm.lastActionType}
        lastActionTitle={vm.lastActionTitle}
        controlState={controlState}
        outputSchema={vm.outputSchema}
        browserSessionMetadata={vm.browserSessionMetadata}
        onExpand={ui.onExpand}
        onThumbnailClick={ui.onThumbnailClick}
        onFullscreenClick={ui.onFullscreenToggle}
      />
    );
  }

  return (
    <BrowserStatusBarExpanded
      taskId={taskId}
      browserUrl={activeBrowserUrl}
      isDisconnected={isDisconnected}
      isWaitingForAuthAssistance={isWaitingForAuthAssistance}
      outputSchema={vm.outputSchema}
      browserSessionMetadata={vm.browserSessionMetadata}
      stepProgress={vm.stepProgress}
      onThumbnailClick={ui.onThumbnailClick}
      onFullscreenToggle={ui.onFullscreenToggle}
      onCollapse={ui.onCollapse}
    />
  );
}

const BrowserStatusBar = memo(BrowserStatusBarImpl);
export default BrowserStatusBar;
