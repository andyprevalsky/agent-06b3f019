/**
 * STATE MACHINE: BrowserViewPanel
 *
 * EXPANSION STATE:
 * [COLLAPSED] <-- isExpanded: false
 *     |
 *     v
 * [EXPANDED] <-- isExpanded: true
 *
 * FULLSCREEN STATE:
 * [NORMAL] <-- isFullscreen: false
 *     |
 *     v
 * [FULLSCREEN] <-- isFullscreen: true (renders via portal)
 *
 * STREAMING STATE:
 * [POLLING] --> fetches browser screenshot periodically
 *     |
 *     +--> imgSrc: string (current screenshot URL with cache-bust)
 *     +--> agentStatus determines poll interval
 *
 * States:
 * - isExpanded: boolean
 * - isFullscreen: boolean
 * - imgSrc: string
 */

import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAgentContext } from '../hooks';
import { BrowserCompletionView } from './browser-view-panel/BrowserCompletionView';
import { BrowserViewBody } from './browser-view-panel/BrowserViewBody';
import { PortalActionsPanel } from './browser-view-panel/ActionsPanel';
import {
  useActionsPanelPosition,
  useBrowserCompletion,
  useBrowserResume,
  useDisconnectListener,
  usePendingWriteLockApproval,
} from './browser-view-panel/hooks';

interface BrowserViewPanelProps {
  taskId: string;
  browserUrl: string;
  isAnyBrowserFullscreen: boolean;
  onFullscreenToggle: (isFullscreen: boolean) => void;
  onApprovalHandled?: () => void;
}

export default function BrowserViewPanel({
  taskId,
  browserUrl,
  isAnyBrowserFullscreen,
  onFullscreenToggle,
  onApprovalHandled,
}: BrowserViewPanelProps) {
  const { messages } = useAgentContext();
  const [isThisFullscreen, setIsThisFullscreen] = useState(false);
  const browserContainerRef = useRef<HTMLDivElement>(null);

  const { isComplete, isSuccess, completionMessage } = useBrowserCompletion(messages, taskId);
  const pendingWriteLockApproval = usePendingWriteLockApproval(messages);
  const [isDisconnected, setIsDisconnected] = useDisconnectListener(isComplete);
  const actionsPosition = useActionsPanelPosition(browserContainerRef, isAnyBrowserFullscreen);
  const { currentBrowserUrl, isResuming, handleResume } = useBrowserResume(
    taskId,
    browserUrl,
    setIsDisconnected,
  );

  const toggleFullscreen = () => {
    const next = !isThisFullscreen;
    setIsThisFullscreen(next);
    onFullscreenToggle(next);
  };

  if (isComplete) {
    return (
      <div className="animate-in fade-in duration-300 w-full">
        <div className="max-w-4xl mx-auto">
          <BrowserCompletionView
            taskId={taskId}
            isSuccess={isSuccess}
            message={completionMessage}
          />
        </div>
      </div>
    );
  }

  const showPortalPanel = !isAnyBrowserFullscreen && typeof window !== 'undefined';

  return (
    <>
      {showPortalPanel &&
        createPortal(
          <PortalActionsPanel taskId={taskId} position={actionsPosition} />,
          document.body,
        )}

      <BrowserViewBody
        containerRef={browserContainerRef}
        taskId={taskId}
        messages={messages}
        currentBrowserUrl={currentBrowserUrl}
        isThisFullscreen={isThisFullscreen}
        isDisconnected={isDisconnected}
        isResuming={isResuming}
        pendingWriteLockApproval={pendingWriteLockApproval}
        onToggleFullscreen={toggleFullscreen}
        onResume={() => {
          void handleResume();
        }}
        onApprovalHandled={onApprovalHandled}
      />
    </>
  );
}
