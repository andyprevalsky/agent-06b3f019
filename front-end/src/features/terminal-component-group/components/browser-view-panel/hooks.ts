import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resumeBrowserSession, type Message } from '../../hooks';

interface RequestUserApprovalMeta {
  writePermission?: boolean;
  attentionRequestId?: string;
}

interface BrowserMessageMeta {
  task_id?: string;
  action_type?: string;
  toolStatus?: string;
  requestUserApproval?: RequestUserApprovalMeta;
}

const DISCONNECT_MESSAGE = 'browserbase-disconnected';
const ACTIONS_PANEL_OFFSET_LEFT = 320;

function getMeta(message: Message | undefined): BrowserMessageMeta | undefined {
  return message?.metadata as BrowserMessageMeta | undefined;
}

export interface CompletionStatus {
  isComplete: boolean;
  isSuccess: boolean;
  completionMessage?: string;
}

/** Derive completion status from the most recent browser task message. */
export function useBrowserCompletion(messages: Message[], taskId: string): CompletionStatus {
  return useMemo(() => {
    const browserMessages = messages.filter((m) => getMeta(m)?.task_id === taskId);
    const lastMessage = browserMessages[browserMessages.length - 1];
    const complete = getMeta(lastMessage)?.action_type === 'task_complete';

    return {
      isComplete: complete,
      isSuccess: complete,
      completionMessage: complete ? lastMessage?.text : undefined,
    };
  }, [messages, taskId]);
}

export interface PendingWriteLockApproval {
  attentionRequestId: string;
  question: string;
}

/** Find the in-progress write-permission attention request, if any. */
export function usePendingWriteLockApproval(
  messages: Message[],
): PendingWriteLockApproval | null {
  return useMemo(() => {
    const approvalMessage = messages.find((m) => {
      const meta = getMeta(m);
      return (
        meta?.toolStatus === 'IN_PROGRESS' &&
        meta.requestUserApproval?.writePermission === true &&
        meta.requestUserApproval.attentionRequestId
      );
    });

    if (!approvalMessage) return null;

    const meta = getMeta(approvalMessage);
    const attentionRequestId = meta?.requestUserApproval?.attentionRequestId;
    if (!attentionRequestId) return null;

    return {
      attentionRequestId,
      question: approvalMessage.text || 'Approve this write action?',
    };
  }, [messages]);
}

/** Listen for postMessage from the browser iframe to detect disconnects. */
export function useDisconnectListener(isComplete: boolean): [boolean, (v: boolean) => void] {
  const [isDisconnected, setIsDisconnected] = useState(false);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data === DISCONNECT_MESSAGE && !isComplete) {
        setIsDisconnected(true);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [isComplete]);

  return [isDisconnected, setIsDisconnected];
}

export interface ActionsPanelPosition {
  top: number;
  left: number;
  height: number;
}

/** Track the browser container's viewport position so we can portal an actions panel beside it. */
export function useActionsPanelPosition(
  containerRef: React.RefObject<HTMLDivElement>,
  isAnyBrowserFullscreen: boolean,
): ActionsPanelPosition {
  const [position, setPosition] = useState<ActionsPanelPosition>({ top: 0, left: 0, height: 0 });

  useEffect(() => {
    if (isAnyBrowserFullscreen) return;

    const updatePosition = () => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        setPosition({
          top: rect.top,
          left: rect.left - ACTIONS_PANEL_OFFSET_LEFT,
          height: rect.height,
        });
      }
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);

    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [containerRef, isAnyBrowserFullscreen]);

  return position;
}

export interface BrowserResumeState {
  currentBrowserUrl: string;
  isResuming: boolean;
  handleResume: () => Promise<void>;
}

/** Manages the browser URL state and resume flow. */
export function useBrowserResume(
  taskId: string,
  browserUrl: string,
  setIsDisconnected: (v: boolean) => void,
): BrowserResumeState {
  const [currentBrowserUrl, setCurrentBrowserUrl] = useState(browserUrl);
  const [isResuming, setIsResuming] = useState(false);

  useEffect(() => {
    setCurrentBrowserUrl(browserUrl);
  }, [browserUrl]);

  const handleResume = useCallback(async () => {
    setIsResuming(true);
    try {
      const data = await resumeBrowserSession(taskId);
      setCurrentBrowserUrl(data.debug_url);
      setIsDisconnected(false);
    } catch (error) {
      console.error('Failed to resume browser session:', error);
      window.alert('Failed to resume browser session. Please try again or start a new session.');
    } finally {
      setIsResuming(false);
    }
  }, [taskId, setIsDisconnected]);

  return { currentBrowserUrl, isResuming, handleResume };
}

/** Utility to get a stable ref for elements. */
export function useBrowserContainerRef() {
  return useRef<HTMLDivElement>(null);
}
