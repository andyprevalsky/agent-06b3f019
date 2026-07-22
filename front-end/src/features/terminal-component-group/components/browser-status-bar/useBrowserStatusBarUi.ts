/**
 * UI-state hook for BrowserStatusBar. Owns the expand/fullscreen/resume flags
 * and the event handlers the three presentational variants consume. Pulled
 * out of BrowserStatusBar.tsx so the orchestrator stays under the 80-line
 * max-lines-per-function cap.
 */

import { useCallback, useEffect, useState, type MouseEvent } from 'react';
import {
  readBrowserControlState,
  releaseBrowserControl,
  resumeAgent,
  takeBrowserControl,
} from '@/lib/api';
import { getQueryParams } from '@/lib/url';
import { completeAuthAssistanceRequest, resumeBrowserSession } from '../../hooks';

export interface BrowserStatusBarUi {
  isExpanded: boolean;
  isFullscreen: boolean;
  isResuming: boolean;
  isUserControlling: boolean;
  hasReconnected: boolean;
  browserUrl: string;
  onExpand: () => void;
  onCollapse: () => void;
  onThumbnailClick: (e: MouseEvent) => void;
  onFullscreenToggle: (e: MouseEvent) => void;
  onFullscreenClose: (e: MouseEvent) => void;
  onTakeControl: (isDisconnected: boolean) => void;
  onHandBackControl: () => void;
  onCompleteAuthAssistance: (requestId: string) => void;
}

interface SessionOverride {
  sourceBrowserUrl: string;
  browserUrl: string;
  resumedFromDisconnected?: boolean;
}

interface BrowserControlTransitions {
  setBusy: (busy: boolean) => void;
  setResumedSession: (session: SessionOverride) => void;
  setUserControl: (session: SessionOverride | null) => void;
}

function currentSession(
  session: SessionOverride | null,
  browserUrl: string,
): SessionOverride | null {
  return session?.sourceBrowserUrl === browserUrl ? session : null;
}

export function interactiveBrowserUrl(browserUrl: string): string {
  try {
    const url = new URL(browserUrl);
    url.searchParams.delete('readOnly');
    url.searchParams.set('interactive', 'true');
    url.searchParams.set('showControls', 'true');
    return url.toString();
  } catch {
    const separator = browserUrl.includes('?') ? '&' : '?';
    return `${browserUrl}${separator}interactive=true&showControls=true`;
  }
}

async function requestUserControl(
  taskId: string,
  browserUrl: string,
  isDisconnected: boolean,
  transitions: BrowserControlTransitions,
): Promise<void> {
  transitions.setBusy(true);
  try {
    let liveBrowserUrl = browserUrl;
    if (isDisconnected) {
      const resumed = await resumeBrowserSession(taskId);
      liveBrowserUrl = resumed.debug_url || browserUrl;
      transitions.setResumedSession({ sourceBrowserUrl: browserUrl, browserUrl: liveBrowserUrl });
    }
    const snapshot = await takeBrowserControl(taskId);
    transitions.setUserControl({
      sourceBrowserUrl: browserUrl,
      browserUrl: interactiveBrowserUrl(liveBrowserUrl),
      resumedFromDisconnected: isDisconnected || snapshot.agentPaused,
    });
  } catch (error) {
    await releaseBrowserControl(taskId).catch(() => {});
    console.error('Failed to take control of browser session:', error);
  } finally {
    transitions.setBusy(false);
  }
}

async function returnAgentControl(
  taskId: string,
  agentId: string | null,
  activeUserControl: SessionOverride,
  transitions: BrowserControlTransitions,
): Promise<void> {
  transitions.setBusy(true);
  try {
    if (activeUserControl.resumedFromDisconnected === true && agentId !== null) {
      await resumeAgent(agentId);
    }
    await releaseBrowserControl(taskId);
    transitions.setUserControl(null);
  } catch (error) {
    console.error('Failed to hand browser control back:', error);
  } finally {
    transitions.setBusy(false);
  }
}

function useBrowserControlRecovery(
  taskId: string,
  browserUrl: string,
  activeUserControl: SessionOverride | null,
  setResumedSession: (session: SessionOverride) => void,
  setUserControl: (session: SessionOverride | null) => void,
): void {
  useEffect(() => {
    let cancelled = false;
    const reconcile = async () => {
      try {
        let snapshot = await readBrowserControlState(taskId);
        if (snapshot.state === 'requested') snapshot = await takeBrowserControl(taskId);
        if (!cancelled && snapshot.state === 'user') {
          const liveBrowserUrl = snapshot.debugUrl || browserUrl;
          const recoveredControl = {
            sourceBrowserUrl: browserUrl,
            browserUrl: interactiveBrowserUrl(liveBrowserUrl),
            resumedFromDisconnected: snapshot.agentPaused,
          };
          if (snapshot.agentPaused) {
            setResumedSession({
              sourceBrowserUrl: browserUrl,
              browserUrl: liveBrowserUrl,
              resumedFromDisconnected: true,
            });
          }
          setUserControl(recoveredControl);
        }
      } catch (error) {
        console.error('Failed to reconcile browser control ownership:', error);
      }
    };
    void reconcile();
    return () => {
      cancelled = true;
    };
  }, [browserUrl, setResumedSession, setUserControl, taskId]);

  useEffect(() => {
    if (activeUserControl === null) return undefined;
    const timer = window.setInterval(() => {
      void takeBrowserControl(taskId).catch((error) => {
        console.error('Failed to renew browser control lease:', error);
        setUserControl(null);
      });
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [activeUserControl, setUserControl, taskId]);
}

function useBrowserSessionControl(
  taskId: string,
  agentId: string | null,
  browserUrl: string,
): Pick<
  BrowserStatusBarUi,
  | 'isResuming'
  | 'isUserControlling'
  | 'hasReconnected'
  | 'browserUrl'
  | 'onTakeControl'
  | 'onHandBackControl'
  | 'onCompleteAuthAssistance'
> {
  const [isResuming, setIsResuming] = useState(false);
  const [resumedSession, setResumedSession] = useState<SessionOverride | null>(null);
  const [userControl, setUserControl] = useState<SessionOverride | null>(null);

  const activeResumedSession = currentSession(resumedSession, browserUrl);
  const activeUserControl = currentSession(userControl, browserUrl);
  useBrowserControlRecovery(
    taskId,
    browserUrl,
    activeUserControl,
    setResumedSession,
    setUserControl,
  );
  const hasReconnected = activeResumedSession !== null;
  const controlledBrowserUrl =
    activeUserControl?.browserUrl ?? activeResumedSession?.browserUrl ?? browserUrl;
  const handleTakeControl = useCallback(
    (isDisconnected: boolean) =>
      requestUserControl(taskId, browserUrl, isDisconnected, {
        setBusy: setIsResuming,
        setResumedSession,
        setUserControl,
      }),
    [browserUrl, taskId],
  );

  const onTakeControl = useCallback(
    (isDisconnected: boolean) => void handleTakeControl(isDisconnected),
    [handleTakeControl],
  );

  const handleHandBackControl = useCallback(async () => {
    if (activeUserControl === null) return;
    await returnAgentControl(taskId, agentId, activeUserControl, {
      setBusy: setIsResuming,
      setResumedSession,
      setUserControl,
    });
  }, [activeUserControl, agentId, taskId]);
  const onHandBackControl = useCallback(
    () => void handleHandBackControl(),
    [handleHandBackControl],
  );

  const handleCompleteAuthAssistance = useCallback(async (requestId: string) => {
    setIsResuming(true);
    try {
      await completeAuthAssistanceRequest(requestId);
    } catch (error) {
      console.error('Failed to complete authentication assistance:', error);
    } finally {
      setIsResuming(false);
    }
  }, []);
  const onCompleteAuthAssistance = useCallback(
    (requestId: string) => {
      void handleCompleteAuthAssistance(requestId);
    },
    [handleCompleteAuthAssistance],
  );

  return {
    isResuming,
    isUserControlling: activeUserControl !== null,
    hasReconnected,
    browserUrl: controlledBrowserUrl,
    onTakeControl,
    onHandBackControl,
    onCompleteAuthAssistance,
  };
}

function useBrowserPanelVisibility(
  taskId: string,
  forceMinimized: boolean,
): Pick<
  BrowserStatusBarUi,
  | 'isExpanded'
  | 'isFullscreen'
  | 'onExpand'
  | 'onCollapse'
  | 'onThumbnailClick'
  | 'onFullscreenToggle'
  | 'onFullscreenClose'
> {
  const [isExpandedState, setIsExpanded] = useState(false);
  const [isFullscreenState, setIsFullscreen] = useState(() => {
    if (typeof window === 'undefined') return false;
    return getQueryParams().get('browser-id') === taskId;
  });

  useEffect(() => {
    const handleOpenBrowser = (event: Event) => {
      const detail = (event as CustomEvent<{ taskId?: string }>).detail;
      if (detail?.taskId === taskId) {
        setIsFullscreen(true);
      }
    };

    window.addEventListener('navi-open-browser', handleOpenBrowser);
    return () => window.removeEventListener('navi-open-browser', handleOpenBrowser);
  }, [taskId]);

  const onExpand = useCallback(() => setIsExpanded(true), []);
  const onCollapse = useCallback(() => setIsExpanded(false), []);

  const onFullscreenToggle = useCallback((e: MouseEvent) => {
    e.stopPropagation();
    setIsFullscreen((prev) => !prev);
  }, []);

  const onThumbnailClick = useCallback((e: MouseEvent) => {
    e.stopPropagation();
    setIsFullscreen(true);
  }, []);

  const onFullscreenClose = useCallback((e: MouseEvent) => {
    e.stopPropagation();
    setIsFullscreen(false);
  }, []);

  return {
    isExpanded: forceMinimized ? false : isExpandedState,
    isFullscreen: forceMinimized ? false : isFullscreenState,
    onExpand,
    onCollapse,
    onThumbnailClick,
    onFullscreenToggle,
    onFullscreenClose,
  };
}

export function useBrowserStatusBarUi(
  taskId: string,
  forceMinimized: boolean,
  agentId: string | null,
  browserUrl: string,
): BrowserStatusBarUi {
  const visibility = useBrowserPanelVisibility(taskId, forceMinimized);
  const control = useBrowserSessionControl(taskId, agentId, browserUrl);
  return {
    ...visibility,
    ...control,
  };
}
