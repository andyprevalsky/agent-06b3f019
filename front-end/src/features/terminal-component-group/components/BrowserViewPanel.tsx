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
 * - pendingAuthAssistance: null | live browser handoff
 *
 * AGENT ACTIVITY STATE:
 * [ACTIVE] -> BrowserIframe shows active glow/cursor
 * [WAITING_FOR_AUTH_ASSISTANCE] -> BrowserIframe shows Start Agent overlay
 * [DISCONNECTED] -> BrowserIframe shows Take Control overlay
 */

import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { completeAuthAssistanceRequest, useAgentContext } from '../hooks';
import { resolveBrowserControlState } from './browserControlState';
import { BrowserCompletionView } from './browser-view-panel/BrowserCompletionView';
import { BrowserViewBody } from './browser-view-panel/BrowserViewBody';
import { PortalActionsPanel } from './browser-view-panel/ActionsPanel';
import {
  useActionsPanelPosition,
  useBrowserCompletion,
  useBrowserResume,
  useDisconnectListener,
  usePendingAuthAssistance,
  usePendingWriteLockApproval,
} from './browser-view-panel/hooks';
import type { PendingAuthAssistance } from './browser-status-bar/types';

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
  const { agent, messages, selectedAgentId } = useAgentContext();
  const agentId = agent?.agent_id ?? selectedAgentId ?? null;
  const [isThisFullscreen, setIsThisFullscreen] = useState(false);
  const browserContainerRef = useRef<HTMLDivElement>(null);

  const { isComplete, isSuccess, completionMessage } = useBrowserCompletion(messages, taskId);
  const pendingWriteLockApproval = usePendingWriteLockApproval(messages);
  const pendingAuthAssistance = usePendingAuthAssistance(messages, taskId);
  const [isDisconnected, setIsDisconnected] = useDisconnectListener(isComplete);
  const actionsPosition = useActionsPanelPosition(browserContainerRef, isAnyBrowserFullscreen);
  const { currentBrowserUrl, isResuming, handleResume } = useBrowserResume(
    taskId,
    browserUrl,
    setIsDisconnected,
  );
  const { isCompletingAuthAssistance, handleStartAgent } = useStartAgent(
    pendingAuthAssistance,
    handleResume,
  );
  const isWaitingForAuthAssistance = pendingAuthAssistance !== null;
  const controlState = resolveBrowserControlState({
    isDisconnected,
    isWaitingForAuthAssistance,
  });

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
        agentId={agentId}
        taskId={taskId}
        messages={messages}
        currentBrowserUrl={pendingAuthAssistance?.liveViewUrl ?? currentBrowserUrl}
        isThisFullscreen={isThisFullscreen}
        isDisconnected={isDisconnected}
        isWaitingForAuthAssistance={isWaitingForAuthAssistance}
        isResuming={controlState === 'waiting' ? isCompletingAuthAssistance : isResuming}
        pendingWriteLockApproval={pendingWriteLockApproval}
        onToggleFullscreen={toggleFullscreen}
        onResume={() => {
          void (controlState === 'waiting' ? handleStartAgent() : handleResume());
        }}
        onApprovalHandled={onApprovalHandled}
      />
    </>
  );
}

function useStartAgent(pending: PendingAuthAssistance | null, resume: () => Promise<void>) {
  const [isCompletingAuthAssistance, setIsCompletingAuthAssistance] = useState(false);
  const handleStartAgent = async () => {
    if (pending === null) {
      await resume();
      return;
    }
    setIsCompletingAuthAssistance(true);
    try {
      await completeAuthAssistanceRequest(pending.requestId);
    } catch (error) {
      console.error('Failed to complete authentication assistance:', error);
      window.alert('Failed to complete authentication assistance. Please try again.');
    } finally {
      setIsCompletingAuthAssistance(false);
    }
  };
  return { isCompletingAuthAssistance, handleStartAgent };
}
