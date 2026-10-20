/**
 * STATE MACHINE: TerminalContent
 *
 * Composes all terminal hooks and renders the full terminal layout.
 * Delegates business logic to hooks; this file is purely composition and JSX.
 *
 * VIEW ROUTING:
 *   currentView === 'browse'       → <Browse />
 *   currentView === 'settings'     → <Settings />
 *   currentView === 'integrations' → <Integrations />
 *   currentView === 'usage'        → <Usage />
 *   currentView === 'network'      → <NetworkView />
 *   currentView === 'admin-health' → <AdminHealth />
 *   currentView === 'benchmarks'   → <BenchmarksView /> (team-gated tab)
 *   currentView === 'agents'       → agent chat / landing
 *   open-agent deep link           → force 'agents' even from browse/settings
 *   agents + inspectionContext     → compact read-only pill in global control rail
 *
 * PER-USER UI (features/user-ui; signed-in non-archive users):
 *   none / safe mode → stock layout; published shell → UserUiShell replaces chrome
 *   background image/slot → layer BEHIND the app; app bg + grid/canvas fade to
 *     fadeAfterFirstMessage once the selected agent has a USER message
 * ROSE DESKTOP APPS (RoseAppsProvider, flag on only): bare top-right icons
 *   (Browser, Phone, Integrations, Dark mode) + the right-panel slot; panels
 *   overlay the content (no right bar, no content inset). Flag off: no icons.
 * CODE AGENT VIEW (CodeAgentViewProvider, flag on only): a left-bar code-agent
 *   row (or ?agent-id=<owner>&code-agent=<task id>) opens that Claude Code /
 *   Codex session as its own conversation in the chat column; the sidebar marks
 *   its row and AgentChatArea renders it. Flag off: never opens.
 * THEME (RoseThemeProvider, Rose Desktop accounts only): light (default) <->
 *   dark via useRoseTheme().toggle() — the top-right Dark mode icon calls it,
 *   so RoseAppIcons renders inside the provider. Dark adds html.dark and the
 *   calm dark background. Stock accounts and shared views never leave light.
 */

import { useState, useMemo, lazy } from 'react';

import {
  AppSidebar,
  AttentionRequestsProvider,
  CodeAgentViewProvider,
  NetworkView,
  RoseAppIcons,
  RoseAppsProvider,
  SIDEBAR_WIDTH_COLLAPSED,
  unansweredAgentIds,
  useAttentionRequests,
} from '@/features/terminal-component-group';
import { useAppData } from '@/hooks/appDataContext';
import { IS_DEV_MODE } from '@/features/terminal-component-group/config';
import { isAdminOperator } from '@/lib/adminAccounts';
import { isRoseDesktopUser } from '@/lib/roseDesktop';
import { RoseDesktopContext } from '@/hooks/roseDesktopContext';
import { RoseThemeProvider } from '@/features/rose-theme';
import { isBenchmarkSharedView } from '@/lib/benchmarkShare';
import { isBenchmarkArchiveMode } from '@/lib/benchmarkArchive';
import {
  UserUiProvider,
  UserUiShell,
  UserUiSlot,
  useUserUiOpaqueSurfaces,
} from '@/features/user-ui';

import { useTerminalAgents } from '../hooks/useTerminalAgents';
import { useTerminalDerivedState, type TerminalLayoutProps } from './terminalLayoutState';
import { useDrippiness } from '../hooks/useDrippiness';
import { useTileAnimation } from '../hooks/useTileAnimation';
import { usePatternOffset } from '../hooks/usePatternOffset';
import { resolveInitialTerminalView } from '../hooks/resolveInitialTerminalView';
import type { TerminalView } from '../types';
import { BROWSER_REVIEW_TEST_PHONE } from '../config';

import { InspectionAccountBadge } from './InspectionAccountBadge';
import { TerminalHeader } from './TerminalHeader';
import { TerminalBackdrop } from './TerminalBackdrop';
import { MainContent } from './TerminalMainContent';
import { TerminalModals } from './TerminalModals';

const BrowserStatusBarCarousel = lazy(() =>
  import('@/features/terminal-component-group/components/BrowserStatusBarCarousel').then((m) => ({
    default: m.default,
  })),
);

export function TerminalContent(props: {
  loadAgentsRef: React.MutableRefObject<(() => void) | null>;
}): React.JSX.Element;
export function TerminalContent(): React.JSX.Element;
export function TerminalContent() {
  const tileAnimation = useTileAnimation();
  const drip = useDrippiness();
  const { patternOffset, tileColors, colorPalette } = usePatternOffset(tileAnimation.currentFrame);

  const resetAnimationState = () => tileAnimation.reset();
  const initialView = useMemo<TerminalView>(resolveInitialTerminalView, []);
  const [currentView, setCurrentView] = useState<TerminalView>(initialView);
  const agents = useTerminalAgents(currentView, setCurrentView, resetAnimationState);
  const { models, modelsLoading } = useAppData();
  const derived = useTerminalDerivedState(agents);

  return (
    <TerminalLayout
      agents={agents}
      drip={drip}
      tileAnimation={tileAnimation}
      patternOffset={patternOffset}
      tileColors={tileColors}
      colorPalette={colorPalette}
      currentView={currentView}
      setCurrentView={setCurrentView}
      models={models}
      modelsLoading={modelsLoading}
      derived={derived}
    />
  );
}

/** The per-user UI belongs to the signed-in session user only. */
function resolveUserUiUserId(agents: ReturnType<typeof useTerminalAgents>): string | null {
  if (!isRoseDesktopAccount(agents) || isBenchmarkArchiveMode()) return null;
  return agents.user?.id ?? null;
}

/** Rose Desktop chrome is on only for flagged, signed-in accounts (lib/roseDesktop.ts). */
function isRoseDesktopAccount(agents: ReturnType<typeof useTerminalAgents>): boolean {
  return !agents.isAnonymous && isRoseDesktopUser(agents.user);
}

function TerminalLayout(props: TerminalLayoutProps) {
  if (isBenchmarkSharedView()) return <SharedBenchmarkLayout {...props} />;
  const roseDesktop = isRoseDesktopAccount(props.agents);
  return (
    <RoseDesktopContext.Provider value={roseDesktop}>
      <RoseThemeProvider userId={props.agents.user?.id ?? null}>
        <RoseAppsProvider
          agents={props.agents.agents}
          selectedAgentId={props.agents.selectedAgentId}
          onSelectAgent={props.agents.handleSelectAgent}
          publishLayout={roseDesktop}
          onLogout={() => void props.agents.handleLogout()}
        >
          <CodeAgentViewProvider
            enabled={roseDesktop}
            selectedAgentId={props.agents.selectedAgentId}
            onSelectAgent={props.agents.handleSelectAgent}
          >
            <InteractiveTerminalLayout {...props} />
          </CodeAgentViewProvider>
          {roseDesktop && <RoseAppIcons />}
        </RoseAppsProvider>
      </RoseThemeProvider>
    </RoseDesktopContext.Provider>
  );
}

function InteractiveTerminalLayout(props: TerminalLayoutProps) {
  return (
    <UserUiProvider userId={resolveUserUiUserId(props.agents)}>
      <UserUiShell>
        <InteractiveTerminalChrome {...props} />
      </UserUiShell>
    </UserUiProvider>
  );
}

function InteractiveTerminalChrome(props: TerminalLayoutProps) {
  const { agents, drip, tileAnimation, currentView, setCurrentView, derived } = props;
  // THE app-wide attention subscription. Held here because this is the common
  // ancestor of the header (bell + mobile drawer) and the sidebar; every other
  // consumer reads it from context or takes the derived id set as a prop.
  const attention = useAttentionRequests(agents.realtimeReady);
  const attentionAgentIds = useMemo(
    () => unansweredAgentIds(attention.requests),
    [attention.requests],
  );
  return (
    <AttentionRequestsProvider value={attention}>
      <div
        className="h-screen w-screen flex flex-col bg-background dark:bg-navi-black relative overflow-hidden"
        style={{ height: '100dvh' }}
      >
        <TerminalBackdrop
          hasUserMessage={derived.hasUserMessage}
          patternOffset={props.patternOffset}
          tileColors={props.tileColors}
          colorPalette={props.colorPalette}
          animationResetKey={tileAnimation.animationResetKey}
          animationComplete={tileAnimation.animationComplete}
          currentFrame={tileAnimation.currentFrame}
          selectedAgentId={agents.selectedAgentId}
        />

        {currentView !== 'browse' && (
          <TerminalHeader
            onCreateNewAgent={agents.handleCreateNewAgent}
            onSelectAgent={agents.handleSelectAgent}
            onLoginClick={agents.handleLoginClick}
            onLogout={() => {
              void agents.handleLogout();
            }}
            isSignedIn={agents.isFullySignedIn}
            clientSource={agents.clientSource}
            agents={agents.agents}
            isLoadingAgents={agents.isLoadingAgents}
            selectedAgentId={agents.selectedAgentId}
            onRefreshAgents={agents.loadAgents}
            dripStyles={drip.dripStyles}
            blur={drip.blur}
            backgroundColors={drip.backgroundColors}
            borderColor={drip.borderColor}
            shadowIntensity={drip.shadowIntensity}
          />
        )}

        {currentView === 'agents' && <InspectionAccountBadge context={agents.inspectionContext} />}

        <div className="h-screen flex z-[4]" style={{ height: '100dvh' }}>
          <SidebarSection
            agents={agents}
            drip={drip}
            attentionAgentIds={attentionAgentIds}
            onRefreshAttention={attention.refetch}
            currentView={currentView}
            setCurrentView={setCurrentView}
            showBrowse={
              currentView === 'browse' || agents.user?.phone === BROWSER_REVIEW_TEST_PHONE
            }
            showBenchmarks={IS_DEV_MODE || isAdminOperator(agents.user)}
            showAdminHealth={derived.showAdminHealth}
          />

          <MainContent
            agents={agents}
            drip={drip}
            currentView={currentView}
            models={props.models}
            modelsLoading={props.modelsLoading}
            pendingApproval={derived.pendingApproval}
            pendingGates={derived.pendingGates}
            hasActiveAttention={derived.hasActiveAttention}
            browserStatusProps={derived.browserStatusProps}
            systemMessages={derived.systemMessages}
            BrowserStatusBarCarousel={BrowserStatusBarCarousel}
            NetworkView={NetworkView}
            sidebarWidthCollapsed={SIDEBAR_WIDTH_COLLAPSED}
          />
        </div>

        <TerminalModals agents={agents} drip={drip} />
      </div>
    </AttentionRequestsProvider>
  );
}

function SharedBenchmarkLayout({
  agents,
  drip,
  derived,
  models,
  modelsLoading,
}: TerminalLayoutProps) {
  return (
    <div
      className="h-screen w-screen bg-background dark:bg-navi-black"
      style={{ height: '100dvh' }}
    >
      <div className="absolute left-5 top-5 z-50 text-base font-semibold">Rose</div>
      <MainContent
        agents={agents}
        drip={drip}
        currentView="agents"
        models={models}
        modelsLoading={modelsLoading}
        pendingApproval={derived.pendingApproval}
        pendingGates={derived.pendingGates}
        hasActiveAttention={derived.hasActiveAttention}
        browserStatusProps={derived.browserStatusProps}
        systemMessages={derived.systemMessages}
        BrowserStatusBarCarousel={BrowserStatusBarCarousel}
        NetworkView={NetworkView}
        sidebarWidthCollapsed={0}
      />
    </div>
  );
}

// ── Sidebar wrapper ─────────────────────────────────────────────────────

function SidebarSection({
  agents,
  drip,
  attentionAgentIds,
  onRefreshAttention,
  currentView,
  setCurrentView,
  showBrowse,
  showBenchmarks,
  showAdminHealth,
}: {
  agents: ReturnType<typeof useTerminalAgents>;
  drip: ReturnType<typeof useDrippiness>;
  attentionAgentIds: ReadonlySet<string>;
  onRefreshAttention: () => void | Promise<void>;
  currentView: TerminalView;
  setCurrentView: (v: TerminalView) => void;
  showBrowse: boolean;
  showBenchmarks: boolean;
  showAdminHealth: boolean;
}) {
  const opaqueSurface = useUserUiOpaqueSurfaces();
  return (
    <AppSidebar
      userUi={{
        opaqueSurface,
        headerSlot: <UserUiSlot name="sidebar.header" autoHeight className="px-3 pb-2" />,
        menuSlot: <UserUiSlot name="menu" autoHeight className="px-3 py-2" />,
      }}
      currentView={currentView}
      onViewChange={setCurrentView}
      showBrowse={showBrowse}
      showBenchmarks={showBenchmarks}
      agents={agents.agents}
      isLoadingAgents={agents.isLoadingAgents}
      selectedAgentId={agents.selectedAgentId}
      onSelectAgent={agents.handleSelectAgent}
      onCreateAgent={agents.handleCreateNewAgent}
      roseActions={{
        onCreateAgentInProject: agents.handleCreateNewAgentInProject,
        onNewAgentInBranch: agents.handleCreateNewAgentInBranch,
      }}
      onRefreshAgents={agents.loadAgents}
      onRefreshAttention={onRefreshAttention}
      attentionAgentIds={attentionAgentIds}
      user={agents.user}
      onLogout={() => {
        void agents.handleLogout();
      }}
      onLoginClick={agents.handleLoginClick}
      showAdminHealth={showAdminHealth}
      dripStyles={drip.dripStyles}
      blur={drip.blur}
      backgroundColors={drip.backgroundColors}
      borderColor={drip.borderColor}
      shadowIntensity={drip.shadowIntensity}
    />
  );
}
