/**
 * STATE MACHINE: RoseAppsProvider (right app bar + app drawers)
 *
 * OPEN APP:
 *   [CLOSED] --click Browser icon | openAgentBrowser(agent, task)--> [BROWSER]
 *   [BROWSER] --click its icon | close button | Escape--> [CLOSED]
 *
 * BROWSER TAB (only meaningful while [BROWSER]):
 *   [ROOT] --click agent tab | openAgentBrowser--> [AGENT(id)]
 *   [AGENT(id)] --click Root tab--> [ROOT]
 *   selectedAgentId changes --> [AGENT(selected)] if it has a browser tab, else [ROOT]
 *   Clicking an agent tab also selects that agent, so its chat (and the
 *   BrowserStatusBar that owns its live session state) mounts.
 *
 * AGENT TABS (registry fed by mounted BrowserStatusBar instances):
 *   register(agentId, taskId, live) --> tab exists / updated
 *   unregister while that agent is still selected (browser task ended) --> tab removed
 *   unregister after switching agents --> tab kept (session still running)
 *   agent leaves the active set (completed/failed/archived) --> tab removed
 *
 * The drawer body for an agent tab is a DOM slot. The focused task's
 * BrowserStatusBar portals its live view into it, so take/hand-back control,
 * session binding and progress state stay owned by that status bar (React
 * context flows through the portal).
 *
 * LAYOUT: with `publishLayout` (the real terminal layout), publishes
 * --rose-apps-inset on <html> (px reserved on the right on md+: app bar + open
 * drawer) so the chat column and header re-center in the remaining width.
 * Drawers portal to <body>; they mount on first open (lazy) and stay mounted
 * afterwards so they can slide out.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useIsMobile } from '@/hooks/use-mobile';
import type { Agent } from '../../hooks';
import {
  APP_BAR_WIDTH,
  DRAWER_GAP,
  defaultDrawerWidth,
  clampDrawerWidth,
  DRAWER_EASE,
  DRAWER_DURATION_MS,
} from './roseAppsLayout';
import { RoseAppDrawers } from './RoseAppDrawers';
import {
  RoseAppsContext,
  type AgentBrowserTab,
  type RoseApp,
  type RoseAppsValue,
} from './roseAppsState';

const ACTIVE_AGENT_STATUSES = new Set<Agent['status']>(['STARTING_UP', 'ACTIVE', 'PAUSED']);

interface ProviderProps {
  children: ReactNode;
  agents?: Agent[];
  selectedAgentId?: string | null;
  onSelectAgent?: (agentId: string) => void;
  /** Publish --rose-apps-inset on <html> (only the app's terminal layout does). */
  publishLayout?: boolean;
}

/** Publish the right inset as CSS vars on <html> while mounted. */
function usePublishedInset(
  enabled: boolean,
  inset: number,
  insetLeft: number,
  isResizing: boolean,
) {
  useLayoutEffect(() => {
    if (!enabled) return undefined;
    const root = document.documentElement.style;
    root.setProperty('--rose-apps-inset', `${inset}px`);
    // While a drawer is open the column also clears the collapsed left rail,
    // so the narrower centered column never slides under it.
    root.setProperty('--rose-apps-inset-left', `${insetLeft}px`);
    // The top-right nav links would collide with the re-centered header pill.
    root.setProperty('--rose-apps-nav-visibility', insetLeft > 0 ? 'hidden' : 'visible');
    root.setProperty(
      '--rose-apps-inset-transition',
      isResizing ? 'none' : `padding ${DRAWER_DURATION_MS}ms ${DRAWER_EASE}`,
    );
    return () => {
      root.removeProperty('--rose-apps-inset');
      root.removeProperty('--rose-apps-inset-left');
      root.removeProperty('--rose-apps-nav-visibility');
      root.removeProperty('--rose-apps-inset-transition');
    };
  }, [enabled, inset, insetLeft, isResizing]);
}

function useAgentTabs(agents: Agent[], selectedAgentId: string | null) {
  const [tabs, setTabs] = useState<AgentBrowserTab[]>([]);
  const selectedRef = useRef(selectedAgentId);
  selectedRef.current = selectedAgentId;

  const registerAgentBrowser = useCallback((tab: AgentBrowserTab) => {
    setTabs((prev) => {
      const existing = prev.find((t) => t.agentId === tab.agentId);
      if (existing === undefined) return [...prev, tab];
      // Another browser of the same agent owns the tab; keep the focused task.
      if (existing.taskId !== tab.taskId || existing.live === tab.live) return prev;
      return prev.map((t) => (t.agentId === tab.agentId ? tab : t));
    });
  }, []);

  const unregisterAgentBrowser = useCallback((agentId: string, taskId: string) => {
    if (selectedRef.current !== agentId) return;
    setTabs((prev) => prev.filter((t) => !(t.agentId === agentId && t.taskId === taskId)));
  }, []);

  const focusTask = useCallback((agentId: string, taskId: string) => {
    setTabs((prev) => {
      const existing = prev.find((t) => t.agentId === agentId);
      if (existing === undefined) return [...prev, { agentId, taskId, live: true }];
      if (existing.taskId === taskId) return prev;
      return prev.map((t) => (t.agentId === agentId ? { ...t, taskId } : t));
    });
  }, []);

  // Drop tabs whose agent is no longer running (only when the list knows it).
  const visibleTabs = useMemo(() => {
    if (agents.length === 0) return tabs;
    return tabs.filter((t) => {
      const agent = agents.find((a) => a.agent_id === t.agentId);
      return agent === undefined || ACTIVE_AGENT_STATUSES.has(agent.status);
    });
  }, [agents, tabs]);

  return { tabs: visibleTabs, registerAgentBrowser, unregisterAgentBrowser, focusTask };
}

function useDrawerWidthState() {
  const [width, setWidth] = useState<number | null>(null);
  const [viewport, setViewport] = useState(() =>
    typeof window === 'undefined' ? 1440 : window.innerWidth,
  );
  useEffect(() => {
    const onResize = () => setViewport(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const drawerWidth = clampDrawerWidth(width ?? defaultDrawerWidth(viewport), viewport);
  const setDrawerWidth = useCallback((next: number) => setWidth(next), []);
  return { drawerWidth, setDrawerWidth };
}

export function RoseAppsProvider({
  children,
  agents = [],
  selectedAgentId = null,
  onSelectAgent,
  publishLayout = false,
}: ProviderProps) {
  const [openApp, setOpenApp] = useState<RoseApp | null>(null);
  const [browserTabAgentId, setBrowserTabAgentId] = useState<string | null>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const { drawerWidth, setDrawerWidth } = useDrawerWidthState();
  const { tabs, registerAgentBrowser, unregisterAgentBrowser, focusTask } = useAgentTabs(
    agents,
    selectedAgentId,
  );
  const isMobile = useIsMobile();

  // Selecting an agent in the agent list switches to its tab. Its status bar
  // may register after the selection, so a pending switch completes on register.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const pendingSwitchRef = useRef<string | null>(null);
  const isFirstSelectionRef = useRef(true);
  useEffect(() => {
    if (isFirstSelectionRef.current) {
      isFirstSelectionRef.current = false;
      return;
    }
    const hasTab = tabsRef.current.some((t) => t.agentId === selectedAgentId);
    pendingSwitchRef.current = hasTab ? null : selectedAgentId;
    setBrowserTabAgentId(hasTab ? selectedAgentId : null);
  }, [selectedAgentId]);
  const registerAndSwitch = useCallback(
    (tab: AgentBrowserTab) => {
      registerAgentBrowser(tab);
      if (pendingSwitchRef.current === tab.agentId) {
        pendingSwitchRef.current = null;
        setBrowserTabAgentId(tab.agentId);
      }
    },
    [registerAgentBrowser],
  );

  const toggleApp = useCallback(
    (app: RoseApp) => {
      // Opening Browser lands on the selected agent's tab when it has one.
      if (app === 'browser' && openApp !== 'browser') {
        const hasTab = tabsRef.current.some((t) => t.agentId === selectedAgentId);
        if (hasTab) setBrowserTabAgentId(selectedAgentId);
      }
      setOpenApp((prev) => (prev === app ? null : app));
    },
    [openApp, selectedAgentId],
  );
  const closeApp = useCallback(() => setOpenApp(null), []);

  const openAgentBrowser = useCallback(
    (agentId: string, taskId: string) => {
      focusTask(agentId, taskId);
      setBrowserTabAgentId(agentId);
      setOpenApp('browser');
    },
    [focusTask],
  );

  const selectBrowserTab = useCallback(
    (agentId: string | null) => {
      setBrowserTabAgentId(agentId);
      if (agentId !== null && agentId !== selectedAgentId) onSelectAgent?.(agentId);
    },
    [onSelectAgent, selectedAgentId],
  );

  useEffect(() => {
    if (openApp === null) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenApp(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openApp]);

  const isTaskInDrawer = useCallback(
    (agentId: string | null, taskId: string) =>
      openApp === 'browser' &&
      agentId !== null &&
      browserTabAgentId === agentId &&
      tabs.some((t) => t.agentId === agentId && t.taskId === taskId),
    [browserTabAgentId, openApp, tabs],
  );

  const value = useMemo<RoseAppsValue>(
    () => ({
      openApp,
      browserTabAgentId,
      tabs,
      agents,
      selectedAgentId,
      drawerWidth,
      isResizing,
      slot,
      toggleApp,
      closeApp,
      openAgentBrowser,
      selectBrowserTab,
      setSlot,
      setDrawerWidth,
      setIsResizing,
      registerAgentBrowser: registerAndSwitch,
      unregisterAgentBrowser,
      isTaskInDrawer,
    }),
    [
      openApp,
      browserTabAgentId,
      tabs,
      agents,
      selectedAgentId,
      drawerWidth,
      isResizing,
      slot,
      toggleApp,
      closeApp,
      openAgentBrowser,
      selectBrowserTab,
      setDrawerWidth,
      registerAndSwitch,
      unregisterAgentBrowser,
      isTaskInDrawer,
    ],
  );

  const inset = isMobile
    ? 0
    : APP_BAR_WIDTH + (openApp !== null ? drawerWidth + DRAWER_GAP * 2 : 0);
  const insetLeft = !isMobile && openApp !== null ? APP_BAR_WIDTH : 0;
  usePublishedInset(publishLayout, inset, insetLeft, isResizing);

  return (
    <RoseAppsContext.Provider value={value}>
      {children}
      {typeof document !== 'undefined' && createPortal(<RoseAppDrawers />, document.body)}
    </RoseAppsContext.Provider>
  );
}
