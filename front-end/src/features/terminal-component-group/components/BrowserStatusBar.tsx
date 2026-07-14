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
import { useBrowserStatusBarState } from './browser-status-bar/useBrowserStatusBarState';
import { useBrowserStatusBarUi } from './browser-status-bar/useBrowserStatusBarUi';
import { useRefreshedAuthAssistanceUrl } from './browser-status-bar/useRefreshedAuthAssistanceUrl';
import type { BrowserStatusBarProps } from './browser-status-bar/types';

function BrowserStatusBarImpl({
  taskId,
  browserUrl,
  forceMinimized = false,
}: BrowserStatusBarProps) {
  const { agent, messages, selectedAgentId } = useAgentContext();
  const agentId = agent?.agent_id ?? selectedAgentId ?? null;
  const vm = useBrowserStatusBarState(taskId);
  const ui = useBrowserStatusBarUi(taskId, forceMinimized);
  const refreshedAuthUrl = useRefreshedAuthAssistanceUrl(vm.pendingAuthAssistance);
  const activeBrowserUrl = refreshedAuthUrl ?? vm.pendingAuthAssistance?.liveViewUrl ?? browserUrl;
  const isWaitingForAuthAssistance = vm.pendingAuthAssistance !== null;
  const handleResume = isWaitingForAuthAssistance
    ? () => {
        if (vm.pendingAuthAssistance) {
          void ui.onCompleteAuthAssistance(vm.pendingAuthAssistance.requestId);
        }
      }
    : ui.onResume;

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
        isDisconnected={vm.isDisconnected}
        isWaitingForAuthAssistance={isWaitingForAuthAssistance}
        authAssistanceRequest={vm.pendingAuthAssistance?.request}
        isResuming={ui.isResuming}
        pendingWriteLockApproval={vm.pendingWriteLockApproval}
        onClose={ui.onFullscreenClose}
        onResume={handleResume}
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
        isWaitingForAuthAssistance={isWaitingForAuthAssistance}
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
      isDisconnected={vm.isDisconnected}
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
