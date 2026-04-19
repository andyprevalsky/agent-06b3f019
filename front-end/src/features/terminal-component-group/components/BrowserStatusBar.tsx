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
 */

import { memo } from 'react';
import { useAgentContext } from '../hooks';
import { BrowserStatusBarExpanded } from './browser-status-bar/BrowserStatusBarExpanded';
import { BrowserStatusBarFullscreen } from './browser-status-bar/BrowserStatusBarFullscreen';
import { BrowserStatusBarMinimized } from './browser-status-bar/BrowserStatusBarMinimized';
import { useBrowserStatusBarState } from './browser-status-bar/useBrowserStatusBarState';
import { useBrowserStatusBarUi } from './browser-status-bar/useBrowserStatusBarUi';
import type { BrowserStatusBarProps } from './browser-status-bar/types';

function BrowserStatusBarImpl({
  taskId,
  browserUrl,
  forceMinimized = false,
}: BrowserStatusBarProps) {
  const { messages } = useAgentContext();
  const vm = useBrowserStatusBarState(taskId);
  const ui = useBrowserStatusBarUi(taskId, forceMinimized);

  if (ui.isFullscreen) {
    return (
      <BrowserStatusBarFullscreen
        taskId={taskId}
        browserUrl={browserUrl}
        messages={messages}
        outputSchema={vm.outputSchema}
        stepProgress={vm.stepProgress}
        isDisconnected={vm.isDisconnected}
        isResuming={ui.isResuming}
        pendingWriteLockApproval={vm.pendingWriteLockApproval}
        onClose={ui.onFullscreenClose}
        onResume={ui.onResume}
      />
    );
  }

  if (!ui.isExpanded) {
    return (
      <BrowserStatusBarMinimized
        browserUrl={browserUrl}
        forceMinimized={forceMinimized}
        lastActionType={vm.lastActionType}
        lastActionTitle={vm.lastActionTitle}
        outputSchema={vm.outputSchema}
        onExpand={ui.onExpand}
        onThumbnailClick={ui.onThumbnailClick}
      />
    );
  }

  return (
    <BrowserStatusBarExpanded
      taskId={taskId}
      browserUrl={browserUrl}
      isDisconnected={vm.isDisconnected}
      outputSchema={vm.outputSchema}
      stepProgress={vm.stepProgress}
      onThumbnailClick={ui.onThumbnailClick}
      onFullscreenToggle={ui.onFullscreenToggle}
      onCollapse={ui.onCollapse}
    />
  );
}

const BrowserStatusBar = memo(BrowserStatusBarImpl);
export default BrowserStatusBar;
