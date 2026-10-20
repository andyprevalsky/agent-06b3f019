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
 * PER-USER UI (features/user-ui, signed-in non-archive users only):
 *   no published UI / safe mode    → stock layout (unchanged)
 *   published shell                → UserUiShell replaces the whole chrome
 *   background image / slot        → fixed layer BEHIND the app; the app's own
 *                                    background + grid/canvas layers fade to
 *                                    fadeAfterFirstMessage once the selected
 *                                    agent has a USER message (opaque before)
 */

import { useState, useMemo, lazy } from 'react';

import {
  AppSidebar,
  AttentionRequestsProvider,
  NetworkView,
  SIDEBAR_WIDTH_COLLAPSED,
  unansweredAgentIds,
  useAttentionRequests,
} from '@/features/terminal-component-group';
import { useAppData } from '@/hooks/appDataContext';
import { IS_DEV_MODE } from '@/features/terminal-component-group/config';
import { isAdminOperator } from '@/lib/adminAccounts';
import { isBenchmarkSharedView } from '@/lib/benchmarkShare';
import { isBenchmarkArchiveMode } from '@/lib/benchmarkArchive';
import {
  UserUiProvider,
  UserUiShell,
  UserUiSlot,
  useUserUiOpaqueSurfaces,
} from '@/features/user-ui';

import { useTerminalAgents } from '../hooks/useTerminalAgents';
import { useDrippiness } from '../hooks/useDrippiness';
import { useTileAnimation } from '../hooks/useTileAnimation';
import { usePatternOffset } from '../hooks/usePatternOffset';
import { resolveInitialTerminalView } from '../hooks/resolveInitialTerminalView';
import {
  computeActiveBrowserPanels,
  derivePendingApproval,
  derivePendingGates,
  deriveHasActiveAttentionRequest,
} from '../hooks/derivations';
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

function useTerminalDerivedState(agents: ReturnType<typeof useTerminalAgents>) {
  const activeBrowserPanels = useMemo(
    () => computeActiveBrowserPanels(agents.messages),
    [agents.messages],
  );
  const pendingApproval = useMemo(() => derivePendingApproval(agents.messages), [agents.messages]);
  const pendingGates = useMemo(() => derivePendingGates(agents.messages), [agents.messages]);
  const hasActiveAttention = useMemo(
    () => deriveHasActiveAttentionRequest(agents.messages),
    [agents.messages],
  );
  const browserStatusProps = useMemo(
    () => (activeBrowserPanels.length === 0 ? null : { browsers: activeBrowserPanels }),
    [activeBrowserPanels],
  );
  return {
    pendingApproval,
    pendingGates,
    hasActiveAttention,
    browserStatusProps,
    systemMessages: agents.messages.filter((message) => message.role === 'SYSTEM'),
    showAdminHealth: isAdminOperator(agents.user),
    hasUserMessage:
      agents.selectedAgentId !== null && agents.messages.some((message) => message.role === 'USER'),
  };
}

/** The per-user UI belongs to the signed-in session user only. */
function resolveUserUiUserId(agents: ReturnType<typeof useTerminalAgents>): string | null {
  if (agents.isAnonymous || isBenchmarkArchiveMode()) return null;
  return agents.user?.id ?? null;
}

interface TerminalLayoutProps {
  agents: ReturnType<typeof useTerminalAgents>;
  drip: ReturnType<typeof useDrippiness>;
  tileAnimation: ReturnType<typeof useTileAnimation>;
  patternOffset: ReturnType<typeof usePatternOffset>['patternOffset'];
  tileColors: ReturnType<typeof usePatternOffset>['tileColors'];
  colorPalette: ReturnType<typeof usePatternOffset>['colorPalette'];
  currentView: TerminalView;
  setCurrentView: (view: TerminalView) => void;
  models: ReturnType<typeof useAppData>['models'];
  modelsLoading: boolean;
  derived: ReturnType<typeof useTerminalDerivedState>;
}

function TerminalLayout(props: TerminalLayoutProps) {
  if (isBenchmarkSharedView()) return <SharedBenchmarkLayout {...props} />;
  return <InteractiveTerminalLayout {...props} />;
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
