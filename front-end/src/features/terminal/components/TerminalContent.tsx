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
 *   currentView === 'benchmarks'   → <BenchmarksView /> (team-gated tab)
 *   currentView === 'agents'       → agent chat / landing
 */

import { useState, useMemo, lazy } from 'react';
import { useNavigate } from 'react-router-dom';

import { ScrollArea } from '@/components/ui/scroll-area';
import { AppSidebar, SIDEBAR_WIDTH_COLLAPSED } from '@/features/terminal-component-group';
import Settings from '@/pages/Settings';
import Browse from '@/pages/Browse';
import Integrations from '@/pages/Integrations';
import Usage from '@/pages/Usage';
import { NetworkView } from '@/features/terminal-component-group';
import { BenchmarksView } from '@/features/benchmarks';
import { ADMIN_USER_IDS, IS_DEV_MODE } from '@/features/terminal-component-group/config';
import { cn } from '@/lib/utils';
import { useAppData } from '@/hooks/useAppData';
import { getItem } from '@/lib/storage';

import { useTerminalAgents } from '../hooks/useTerminalAgents';
import { useDrippiness } from '../hooks/useDrippiness';
import { useTileAnimation } from '../hooks/useTileAnimation';
import { usePatternOffset } from '../hooks/usePatternOffset';
import {
  computeActiveBrowserPanels,
  derivePendingApproval,
  deriveHasActiveAttentionRequest,
} from '../hooks/derivations';
import type { TerminalView } from '../types';
import { BROWSER_REVIEW_TEST_PHONE } from '../config';

import { BackgroundPattern } from './BackgroundPattern';
import { TerminalHeader } from './TerminalHeader';
import { AgentChatArea } from './AgentChatArea';
import { TerminalModals } from './TerminalModals';

const BrowserStatusBarCarousel = lazy(() =>
  import('@/features/terminal-component-group/components/BrowserStatusBarCarousel').then((m) => ({
    default: m.default,
  })),
);

function resolveInitialView(): TerminalView {
  const stored = getItem('app-user');
  if (stored === null) return 'agents';
  try {
    const user = JSON.parse(stored) as { phone?: string };
    return user.phone === BROWSER_REVIEW_TEST_PHONE ? 'browse' : 'agents';
  } catch {
    return 'agents';
  }
}

function browseOffsetStyle(currentView: TerminalView): React.CSSProperties | undefined {
  // Full-width views (browse, benchmarks) must clear the fixed sidebar rail —
  // centered views never reach under it, but max-w-none content does.
  return currentView === 'browse' || currentView === 'benchmarks'
    ? ({ '--browse-sidebar-offset': `${SIDEBAR_WIDTH_COLLAPSED}px` } as React.CSSProperties)
    : undefined;
}

function ScrolledPage({ children }: { children: React.ReactNode }) {
  return (
    <ScrollArea className="flex-1 h-full">
      <div className="pt-24 pb-8">{children}</div>
    </ScrollArea>
  );
}

export function TerminalContent() {
  const tileAnimation = useTileAnimation();
  const drip = useDrippiness();
  const { patternOffset, tileColors, colorPalette } = usePatternOffset(tileAnimation.currentFrame);

  const resetAnimationState = () => tileAnimation.reset();
  const initialView = useMemo<TerminalView>(resolveInitialView, []);
  const [currentView, setCurrentView] = useState<TerminalView>(initialView);
  const agents = useTerminalAgents(currentView, setCurrentView, resetAnimationState);
  const { models, modelsLoading } = useAppData();

  const activeBrowserPanels = useMemo(
    () => computeActiveBrowserPanels(agents.messages),
    [agents.messages],
  );
  const pendingApproval = useMemo(() => derivePendingApproval(agents.messages), [agents.messages]);
  const hasActiveAttention = useMemo(
    () => deriveHasActiveAttentionRequest(agents.messages),
    [agents.messages],
  );
  const browserStatusProps = useMemo(() => {
    if (activeBrowserPanels.length === 0) return null;
    return { browsers: activeBrowserPanels };
  }, [activeBrowserPanels]);
  const systemMessages = agents.messages.filter((m) => m.role === 'SYSTEM');

  return (
    <div
      className="h-screen w-screen flex flex-col bg-background dark:bg-navi-black relative overflow-hidden"
      style={{ height: '100dvh' }}
    >
      <BackgroundPattern
        patternOffset={patternOffset}
        tileColors={tileColors}
        colorPalette={colorPalette}
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
        />

        <MainContent
          agents={agents}
          drip={drip}
          currentView={currentView}
          models={models}
          modelsLoading={modelsLoading}
          pendingApproval={pendingApproval}
          hasActiveAttention={hasActiveAttention}
          browserStatusProps={browserStatusProps}
          systemMessages={systemMessages}
          BrowserStatusBarCarousel={BrowserStatusBarCarousel}
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
}: {
  agents: ReturnType<typeof useTerminalAgents>;
  drip: ReturnType<typeof useDrippiness>;
  currentView: TerminalView;
  setCurrentView: (v: TerminalView) => void;
  showBrowse: boolean;
  showBenchmarks: boolean;
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
      dripStyles={drip.dripStyles}
      blur={drip.blur}
      backgroundColors={drip.backgroundColors}
      borderColor={drip.borderColor}
      shadowIntensity={drip.shadowIntensity}
    />
  );
}

// ── Main content area (view router) ─────────────────────────────────────

function MainContent({
  agents,
  drip,
  currentView,
  models,
  modelsLoading,
  pendingApproval,
  hasActiveAttention,
  browserStatusProps,
  systemMessages,
  BrowserStatusBarCarousel: BrowserCarousel,
}: {
  agents: ReturnType<typeof useTerminalAgents>;
  drip: ReturnType<typeof useDrippiness>;
  currentView: TerminalView;
  models: ReturnType<typeof useAppData>['models'];
  modelsLoading: boolean;
  pendingApproval: ReturnType<typeof derivePendingApproval>;
  hasActiveAttention: boolean;
  browserStatusProps: { browsers: { taskId: string; browserUrl: string }[] } | null;
  systemMessages: ReturnType<typeof useTerminalAgents>['messages'];
  BrowserStatusBarCarousel: React.ComponentType<{
    browsers: { taskId: string; browserUrl: string }[];
  }>;
}) {
  return (
    <main
      className={cn(
        'flex-1 flex justify-center h-screen overflow-hidden',
        (currentView === 'browse' || currentView === 'benchmarks') &&
          'md:pl-[var(--browse-sidebar-offset)]',
      )}
      style={{ height: '100dvh', ...browseOffsetStyle(currentView) }}
    >
      <div
        className={cn(
          'flex flex-col relative w-full h-full overflow-hidden',
          currentView === 'browse' ? 'px-0' : 'px-2 md:px-6',
          currentView === 'network' || currentView === 'browse' || currentView === 'benchmarks'
            ? 'max-w-none'
            : 'max-w-5xl',
        )}
      >
        {agents.clientSource === 'WEB' && <DesktopNavLinks />}

        {currentView === 'browse' ? (
          <Browse />
        ) : currentView === 'settings' ? (
          <ScrolledPage>
            <Settings />
          </ScrolledPage>
        ) : currentView === 'integrations' ? (
          <ScrolledPage>
            <Integrations />
          </ScrolledPage>
        ) : currentView === 'usage' ? (
          <ScrolledPage>
            <Usage />
          </ScrolledPage>
        ) : currentView === 'network' ? (
          <NetworkView />
        ) : currentView === 'benchmarks' ? (
          <BenchmarksView />
        ) : (
          <AgentChatArea
            agents={agents}
            drip={drip}
            models={models}
            modelsLoading={modelsLoading}
            pendingApproval={pendingApproval}
            hasActiveAttentionRequest={hasActiveAttention}
            browserStatusProps={browserStatusProps}
            systemMessages={systemMessages}
            BrowserStatusBarCarousel={BrowserCarousel}
          />
        )}
      </div>
    </main>
  );
}

function DesktopNavLinks() {
  const navigate = useNavigate();

  return (
    <div className="hidden md:flex items-center gap-2 absolute top-5 right-2 z-50">
      <button
        onClick={() => navigate('/research')}
        className="px-3 py-1.5 bg-navi-white text-navi-black text-xs font-medium rounded-full border border-border hover:bg-navi-white/80 transition-colors shadow-sm"
      >
        Research
      </button>
      <a
        href="/download"
        target="_blank"
        rel="noopener noreferrer"
        className="px-3 py-1.5 bg-navi-black text-white text-xs font-medium rounded-full hover:bg-navi-black/80 transition-colors shadow-lg"
      >
        Download
      </a>
    </div>
  );
}
