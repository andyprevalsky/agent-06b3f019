/**
 * UI-state hook for BrowserStatusBar. Owns the expand/resume flags, the
 * Browser-drawer open/close handlers (the drawer replaced the old fullscreen
 * view), and the event handlers the presentational variants consume. Pulled
 * out of BrowserStatusBar.tsx so the orchestrator stays under the 80-line
 * max-lines-per-function cap.
 */

import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import {
  readBrowserControlState,
  releaseBrowserControl,
  resumeAgent,
  takeBrowserControl,
} from '@/lib/api';
import { getQueryParams } from '@/lib/url';
import { resumeBrowserSession } from '../../hooks';
import { useCompleteAuthAssistance } from './useCompleteAuthAssistance';
import { useBrowserSessionBinding } from './useBrowserSessionBinding';
import { useRoseApps } from '../rose-apps/roseAppsState';

export interface BrowserStatusBarUi {
  isExpanded: boolean;
  /** This task's live view is shown in the Browser app drawer (agent tab). */
  isInDrawer: boolean;
  isResuming: boolean;
  isUserControlling: boolean;
  hasReconnected: boolean;
  browserUrl: string;
  /** False when the bound provider session is closed or ended: show loading. */
  isLive: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  onThumbnailClick: (e: MouseEvent) => void;
  /** Open this task in the Browser drawer, or close the drawer if it is shown. */
  onDrawerToggle: (e: MouseEvent) => void;
  onTakeControl: (isDisconnected: boolean) => void;
  onHandBackControl: () => void;
  onCompleteAuthAssistance: (requestId: string) => void;
}

/** Per-task control flags. URLs always derive from the session binding. */
interface SessionOverride {
  taskId: string;
  resumedFromDisconnected?: boolean;
}

interface BrowserControlTransitions {
  setBusy: (busy: boolean) => void;
  setResumedSession: (session: SessionOverride) => void;
  setUserControl: (session: SessionOverride | null) => void;
  refreshBinding: () => Promise<void>;
}

function currentSession(session: SessionOverride | null, taskId: string): SessionOverride | null {
  return session?.taskId === taskId ? session : null;
}

function browserUrlForInteraction(browserUrl: string, interactive: boolean): string {
  try {
    const url = new URL(browserUrl);
    if (interactive) url.searchParams.delete('readOnly');
    else url.searchParams.set('readOnly', 'true');
    url.searchParams.set('interactive', String(interactive));
    url.searchParams.set('showControls', String(interactive));
    return url.toString();
  } catch {
    const separator = browserUrl.includes('?') ? '&' : '?';
    return `${browserUrl}${separator}interactive=${interactive}&showControls=${interactive}`;
  }
}

export function interactiveBrowserUrl(browserUrl: string): string {
  return browserUrlForInteraction(browserUrl, true);
}

async function requestUserControl(
  taskId: string,
  isDisconnected: boolean,
  transitions: BrowserControlTransitions,
): Promise<void> {
  transitions.setBusy(true);
  try {
    if (isDisconnected) {
      // Resume rebinds the task's row; read that binding instead of pinning a URL.
      await resumeBrowserSession(taskId);
      await transitions.refreshBinding();
      transitions.setResumedSession({ taskId, resumedFromDisconnected: true });
    }
    const snapshot = await takeBrowserControl(taskId);
    transitions.setUserControl({
      taskId,
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
  activeUserControl: SessionOverride | null,
  setResumedSession: (session: SessionOverride) => void,
  setUserControl: (session: SessionOverride | null) => void,
  readOnly: boolean,
): void {
  useEffect(() => {
    if (readOnly) return;
    let cancelled = false;
    const reconcile = async () => {
      try {
        let snapshot = await readBrowserControlState(taskId);
        if (cancelled) return;
        if (snapshot.state === 'requested') snapshot = await takeBrowserControl(taskId);
        if (!cancelled && snapshot.state === 'user') {
          if (snapshot.debugUrl === null || snapshot.debugUrl === '') return;
          if (snapshot.agentPaused) {
            setResumedSession({ taskId, resumedFromDisconnected: true });
          }
          setUserControl({ taskId, resumedFromDisconnected: snapshot.agentPaused });
        }
      } catch (error) {
        console.error('Failed to reconcile browser control ownership:', error);
      }
    };
    void reconcile();
    return () => {
      cancelled = true;
    };
  }, [readOnly, setResumedSession, setUserControl, taskId]);

  useEffect(() => {
    if (readOnly || activeUserControl === null) return undefined;
    const timer = window.setInterval(() => {
      void takeBrowserControl(taskId).catch((error) => {
        console.error('Failed to renew browser control lease:', error);
        setUserControl(null);
      });
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [activeUserControl, readOnly, setUserControl, taskId]);
}

/**
 * Live-view URL precedence: the user's interactive view of the bound session;
 * the bound session after a resume; during auth assistance, the interactive
 * bound session (every handoff is `same_steel_session_live_view`), falling back
 * to the handoff URL only until a binding is known; otherwise the bound session.
 */
function presentedBrowserUrl(
  binding: { browserUrl: string; isBound: boolean },
  handoffUrl: string | null,
  isUserControlling: boolean,
  hasReconnected: boolean,
  readOnly: boolean,
): string {
  if (readOnly) return browserUrlForInteraction(binding.browserUrl, false);
  if (isUserControlling) return interactiveBrowserUrl(binding.browserUrl);
  if (hasReconnected || handoffUrl === null) return binding.browserUrl;
  return binding.isBound ? interactiveBrowserUrl(binding.browserUrl) : handoffUrl;
}

function useBrowserSessionControl(
  taskId: string,
  agentId: string | null,
  transcriptBrowserUrl: string,
  handoffBrowserUrl: string | null,
  readOnly: boolean,
): Pick<
  BrowserStatusBarUi,
  | 'isResuming'
  | 'isUserControlling'
  | 'hasReconnected'
  | 'browserUrl'
  | 'isLive'
  | 'onTakeControl'
  | 'onHandBackControl'
  | 'onCompleteAuthAssistance'
> {
  const [isResuming, setIsResuming] = useState(false);
  const [resumedSession, setResumedSession] = useState<SessionOverride | null>(null);
  const [userControl, setUserControl] = useState<SessionOverride | null>(null);

  const binding = useBrowserSessionBinding(taskId, transcriptBrowserUrl);
  const refreshBinding = binding.refresh;
  const activeResumedSession = currentSession(resumedSession, taskId);
  const activeUserControl = currentSession(userControl, taskId);
  useBrowserControlRecovery(taskId, activeUserControl, setResumedSession, setUserControl, readOnly);
  const hasReconnected = activeResumedSession !== null;
  const handleTakeControl = useCallback(
    (isDisconnected: boolean) =>
      requestUserControl(taskId, isDisconnected, {
        setBusy: setIsResuming,
        setResumedSession,
        setUserControl,
        refreshBinding,
      }),
    [refreshBinding, taskId],
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
      refreshBinding,
    });
  }, [activeUserControl, agentId, refreshBinding, taskId]);
  const onHandBackControl = useCallback(
    () => void handleHandBackControl(),
    [handleHandBackControl],
  );

  const onCompleteAuthAssistance = useCompleteAuthAssistance(setIsResuming);

  return {
    isResuming,
    isUserControlling: !readOnly && activeUserControl !== null,
    hasReconnected,
    browserUrl: presentedBrowserUrl(
      binding,
      handoffBrowserUrl,
      activeUserControl !== null,
      hasReconnected,
      readOnly,
    ),
    isLive: binding.isLive,
    onTakeControl,
    onHandBackControl,
    onCompleteAuthAssistance,
  };
}

function useBrowserPanelVisibility(
  taskId: string,
  agentId: string | null,
  forceMinimized: boolean,
): Pick<
  BrowserStatusBarUi,
  'isExpanded' | 'isInDrawer' | 'onExpand' | 'onCollapse' | 'onThumbnailClick' | 'onDrawerToggle'
> {
  const apps = useRoseApps();
  const [isExpandedState, setIsExpanded] = useState(false);
  const isInDrawer = apps?.isTaskInDrawer(agentId, taskId) ?? false;
  const openInDrawer = useCallback(() => {
    if (agentId !== null) apps?.openAgentBrowser(agentId, taskId);
  }, [agentId, apps, taskId]);
  const openRef = useRef(openInDrawer);
  openRef.current = openInDrawer;

  // Deep link (?browser-id=<task>) opens the drawer on this agent's tab.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (getQueryParams().get('browser-id') === taskId) openRef.current();
  }, [taskId, agentId]);

  useEffect(() => {
    const handleOpenBrowser = (event: Event) => {
      const detail = (event as CustomEvent<{ taskId?: string }>).detail;
      if (detail?.taskId === taskId) openRef.current();
    };
    window.addEventListener('navi-open-browser', handleOpenBrowser);
    return () => window.removeEventListener('navi-open-browser', handleOpenBrowser);
  }, [taskId]);

  const onExpand = useCallback(() => setIsExpanded(true), []);
  const onCollapse = useCallback(() => setIsExpanded(false), []);

  const onDrawerToggle = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      if (isInDrawer) apps?.closeApp();
      else openInDrawer();
    },
    [apps, isInDrawer, openInDrawer],
  );

  const onThumbnailClick = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      openInDrawer();
    },
    [openInDrawer],
  );

  return {
    isExpanded: forceMinimized ? false : isExpandedState,
    isInDrawer,
    onExpand,
    onCollapse,
    onThumbnailClick,
    onDrawerToggle,
  };
}

/**
 * @param transcriptBrowserUrl latest transcript browser_url for the task
 * @param handoffBrowserUrl pending auth-assistance live view, if any
 */
export function useBrowserStatusBarUi(
  taskId: string,
  forceMinimized: boolean,
  agentId: string | null,
  transcriptBrowserUrl: string,
  handoffBrowserUrl: string | null = null,
  readOnly = false,
): BrowserStatusBarUi {
  const visibility = useBrowserPanelVisibility(taskId, agentId, forceMinimized);
  const control = useBrowserSessionControl(
    taskId,
    agentId,
    transcriptBrowserUrl,
    handoffBrowserUrl,
    readOnly,
  );
  return {
    ...visibility,
    ...control,
  };
}
