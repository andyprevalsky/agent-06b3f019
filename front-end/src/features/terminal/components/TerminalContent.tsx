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
 */

import { useState, useMemo, lazy } from 'react';

import {
  AppSidebar,
  NetworkView,
  SIDEBAR_WIDTH_COLLAPSED,
} from '@/features/terminal-component-group';
import { useAppData } from '@/hooks/useAppData';
import {
  ADMIN_PHONE_DIGITS,
  ADMIN_USER_IDS,
  IS_DEV_MODE,
} from '@/features/terminal-component-group/config';

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

import { BackgroundPattern } from './BackgroundPattern';
import { TerminalHeader } from './TerminalHeader';
import { MainContent } from './TerminalMainContent';
import { TerminalModals } from './TerminalModals';

const BrowserStatusBarCarousel = lazy(() =>
  import('@/features/terminal-component-group/components/BrowserStatusBarCarousel').then((m) => ({
    default: m.default,
  })),
);

function isAdminHealthUser(user: { id?: string; phone?: string } | null): boolean {
  if (!user) return false;
  if (user.id && ADMIN_USER_IDS.includes(user.id)) return true;
  const phoneDigits = (user.phone ?? '').replace(/\D/g, '');
  return ADMIN_PHONE_DIGITS.includes(phoneDigits);
}

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
    showAdminHealth: isAdminHealthUser(agents.user),
  };
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
  const { agents, drip, tileAnimation, currentView, setCurrentView, derived } = props;
  return (
    <div
      className="h-screen w-screen flex flex-col bg-background dark:bg-navi-black relative overflow-hidden"
      style={{ height: '100dvh' }}
    >
      <BackgroundPattern
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
          isSignedIn={agents.isFullySignedIn}
          clientSource={agents.clientSource}
          realtimeReady={agents.realtimeReady}
          dripStyles={drip.dripStyles}
          blur={drip.blur}
          backgroundColors={drip.backgroundColors}
          borderColor={drip.borderColor}
          shadowIntensity={drip.shadowIntensity}
        />
      )}

      <div className="h-screen flex z-[4]" style={{ height: '100dvh' }}>
        <SidebarSection
          agents={agents}
          drip={drip}
          currentView={currentView}
          setCurrentView={setCurrentView}
          showBrowse={currentView === 'browse' || agents.user?.phone === BROWSER_REVIEW_TEST_PHONE}
          showBenchmarks={
            IS_DEV_MODE || (agents.user?.id != null && ADMIN_USER_IDS.includes(agents.user.id))
          }
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
  );
}

// ── Sidebar wrapper ─────────────────────────────────────────────────────

function SidebarSection({
  agents,
  drip,
  currentView,
  setCurrentView,
  showBrowse,
  showBenchmarks,
  showAdminHealth,
}: {
  agents: ReturnType<typeof useTerminalAgents>;
  drip: ReturnType<typeof useDrippiness>;
  currentView: TerminalView;
  setCurrentView: (v: TerminalView) => void;
  showBrowse: boolean;
  showBenchmarks: boolean;
  showAdminHealth: boolean;
}) {
  return (
    <AppSidebar
      currentView={currentView}
      onViewChange={setCurrentView}
      showBrowse={showBrowse}
      showBenchmarks={showBenchmarks}
      agents={agents.agents}
      isLoadingAgents={agents.isLoadingAgents}
      selectedAgentId={agents.selectedAgentId}
      onSelectAgent={agents.handleSelectAgent}
      onCreateAgent={agents.handleCreateNewAgent}
      onResumeAgent={agents.handleResumeAgent}
      resumingAgentId={agents.resumingAgentId}
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
