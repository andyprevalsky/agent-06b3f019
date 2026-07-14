/**
 * UI-state hook for BrowserStatusBar. Owns the expand/fullscreen/resume flags
 * and the event handlers the three presentational variants consume. Pulled
 * out of BrowserStatusBar.tsx so the orchestrator stays under the 80-line
 * max-lines-per-function cap.
 */

import { useCallback, useEffect, useState, type MouseEvent } from 'react';
import { getQueryParams } from '@/lib/url';
import { completeAuthAssistanceRequest, resumeBrowserSession } from '../../hooks';

export interface BrowserStatusBarUi {
  isExpanded: boolean;
  isFullscreen: boolean;
  isResuming: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  onThumbnailClick: (e: MouseEvent) => void;
  onFullscreenToggle: (e: MouseEvent) => void;
  onFullscreenClose: (e: MouseEvent) => void;
  onResume: () => void;
  onCompleteAuthAssistance: (requestId: string) => void;
}

export function useBrowserStatusBarUi(taskId: string, forceMinimized: boolean): BrowserStatusBarUi {
  const [isExpandedState, setIsExpanded] = useState(false);
  const [isFullscreenState, setIsFullscreen] = useState(() => {
    if (typeof window === 'undefined') return false;
    return getQueryParams().get('browser-id') === taskId;
  });
  const [isResuming, setIsResuming] = useState(false);

  const isExpanded = forceMinimized ? false : isExpandedState;
  const isFullscreen = forceMinimized ? false : isFullscreenState;

  const handleResume = useCallback(async () => {
    setIsResuming(true);
    try {
      await resumeBrowserSession(taskId);
    } catch (error) {
      console.error('Failed to resume browser session:', error);
    } finally {
      setIsResuming(false);
    }
  }, [taskId]);

  const onResume = useCallback(() => {
    void handleResume();
  }, [handleResume]);

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
    isExpanded,
    isFullscreen,
    isResuming,
    onExpand,
    onCollapse,
    onThumbnailClick,
    onFullscreenToggle,
    onFullscreenClose,
    onResume,
    onCompleteAuthAssistance,
  };
}
