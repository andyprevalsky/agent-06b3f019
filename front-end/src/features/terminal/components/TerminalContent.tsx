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
 * PER-USER UI (features/user-ui; Rose Desktop, signed-in non-archive users):
 *   none / safe mode → stock layout; published shell → UserUiShell replaces chrome
 *   whole-app theme, background + fade and slots are removed (UI ledger row 89):
 *     the stock background, sidebar and query box always render
 * ROSE DESKTOP APPS (RoseAppsProvider, flag on only): bare top-right icons
 *   (Browser, Phone, Integrations, Dark mode) + the right-panel slot; panels
 *   overlay the content (no right bar, no content inset). Flag off: no icons.
 * APP VIEW (AppViewProvider): a code-agent chip's "Open app" button opens the
 *   code session's preview full screen in place of the chat column (Rose
 *   Desktop only; AgentChatArea). It holds no list and reads nothing itself.
 * CODE AGENT VIEW (CodeAgentViewProvider, flag on only): a left-bar code-agent
 *   row (or ?agent-id=<owner>&code-agent=<task id>) opens that Claude Code /
 *   Codex session as its own conversation in the chat column; the sidebar marks
 *   its row and AgentChatArea renders it. Flag off: never opens.
 * THEME (RoseThemeProvider, Rose Desktop accounts only): light (default) <->
 *   dark via useRoseTheme().toggle() — the top-right Dark mode icon calls it,
 *   so RoseAppIcons renders inside the provider. Dark adds html.dark and the
 *   calm dark background. Stock accounts and shared views never leave light.
 * HEADER FRAME (Rose Desktop): the header sits in a zero-height box spanning
 *   the content area beyond the fixed 64px rail. Sidebar expansion and resize
 *   overlay the trajectory without shifting the header or content. Mobile
 *   headers are fixed and unaffected.
 * DOCUMENT SCROLL: mounted → html.rose-app-shell locks page scroll/overscroll
 *   (panes scroll internally; the mobile query box stays put); unmounted →
 *   class removed so other routes scroll normally.
 */

import { useState, useMemo, lazy, type ReactNode } from 'react';

import {
  AppSidebar,
  AttentionRequestsProvider,
  CodeAgentViewProvider,
  NetworkView,
  RoseAppIcons,
  RoseAppsProvider,
  SIDEBAR_WIDTH_COLLAPSED,
  AppViewProvider,
  unansweredAgentIds,
  useAttentionRequests,
} from '@/features/terminal-component-group';
import { useAppData } from '@/hooks/appDataContext';
import { IS_DEV_MODE } from '@/features/terminal-component-group/config';
import { isAdminOperator } from '@/lib/adminAccounts';
import { isRoseDesktopSession, roseDesktopAccountId } from '@/lib/roseDesktopSession';
import { RoseDesktopContext, useRoseDesktop } from '@/hooks/roseDesktopContext';
import { RoseThemeProvider } from '@/features/rose-theme';
import { isBenchmarkSharedView } from '@/lib/benchmarkShare';
import { isBenchmarkArchiveMode } from '@/lib/benchmarkArchive';
import { UserUiProvider, UserUiShell } from '@/features/user-ui';

import { useTerminalAgents } from '../hooks/useTerminalAgents';
import { useTerminalLogoutAction } from '../hooks/useTerminalLogoutAction';
import { useTerminalDerivedState, type TerminalLayoutProps } from './terminalLayoutState';
import { useDrippiness } from '../hooks/useDrippiness';
import { useLockedDocumentScroll } from '../hooks/useLockedDocumentScroll';
import { useTileAnimation } from '../hooks/useTileAnimation';
import { usePatternOffset } from '../hooks/usePatternOffset';
import { resolveInitialTerminalView } from '../hooks/resolveInitialTerminalView';
import type { TerminalView } from '../types';
import { BROWSER_REVIEW_TEST_PHONE } from '../config';

import { BackgroundPattern } from './BackgroundPattern';
import { InspectionAccountBadge } from './InspectionAccountBadge';
import { TerminalHeaderSection } from './TerminalHeaderSection';
import { MainContent } from './TerminalMainContent';
import { TerminalModals } from './TerminalModals';

const BrowserStatusBarCarousel = lazy(() =>
  import('@/features/terminal-component-group/components/BrowserStatusBarCarousel').then((m) => ({
    default: m.default,
  })),
);

/** iOS keeps the shell on the visible viewport (app-wiring initViewportHeight
 * sets --app-top/--app-height: flush on the keyboard, full-screen in the PWA). */
const APP_SHELL_STYLE = { top: 'var(--app-top, 0px)', height: 'var(--app-height, 100dvh)' };

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
  useLockedDocumentScroll();

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
  if (isBenchmarkArchiveMode()) return null;
  return roseDesktopAccountId(agents);
}

/** Rose Desktop chrome is on only for flagged, signed-in accounts (lib/roseDesktop.ts). */
function isRoseDesktopAccount(agents: ReturnType<typeof useTerminalAgents>): boolean {
  return isRoseDesktopSession(agents);
}

function TerminalLayout(props: TerminalLayoutProps) {
  const onLogout = useTerminalLogoutAction(props.agents.handleLogout);
  if (isBenchmarkSharedView()) return <SharedBenchmarkLayout {...props} />;
  const roseDesktop = isRoseDesktopAccount(props.agents);
  // Same identity that turns Rose Desktop on, so the theme/apps never flip when
  // the async invite check resolves (stock accounts keep the invite-gated user).
  const accountUserId = roseDesktop
    ? roseDesktopAccountId(props.agents)
    : (props.agents.user?.id ?? null);
  return (
    <RoseDesktopContext.Provider value={roseDesktop}>
      <RoseThemeProvider userId={accountUserId} darkOnLogin>
        <RoseAppsProvider
          agents={props.agents.agents}
          selectedAgentId={props.agents.selectedAgentId}
          onSelectAgent={props.agents.handleSelectAgent}
          publishLayout={roseDesktop}
          invitationReady={props.agents.isFullySignedIn}
          onLogout={onLogout}
          onCreateAgentInProject={props.agents.handleCreateNewAgentInProject}
          newAgentFolderId={props.agents.newAgentFolderId}
        >
          <AppViewProvider userId={accountUserId}>
            <CodeAgentViewProvider
              enabled={roseDesktop}
              selectedAgentId={props.agents.selectedAgentId}
              onSelectAgent={props.agents.handleSelectAgent}
            >
              <InteractiveTerminalLayout {...props} />
            </CodeAgentViewProvider>
          </AppViewProvider>
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

/** Rose Desktop: centre the header on the content area beside the left bar (see HEADER FRAME). */
function ContentAreaHeaderFrame({ children }: { children: ReactNode }) {
  const roseDesktop = useRoseDesktop();
  if (!roseDesktop) return <>{children}</>;
  return (
    <div
      data-testid="terminal-header-frame"
      className="absolute inset-x-0 top-0 h-0 md:left-[64px]"
    >
      {children}
    </div>
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
        data-testid="terminal-app-shell"
        className="h-screen w-screen flex flex-col bg-background dark:bg-navi-black fixed left-0 overflow-hidden"
        style={APP_SHELL_STYLE}
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
          <ContentAreaHeaderFrame>
            <TerminalHeaderSection agents={agents} drip={drip} />
          </ContentAreaHeaderFrame>
        )}

        {currentView === 'agents' && <InspectionAccountBadge context={agents.inspectionContext} />}

        <div className="h-screen flex z-[4]" style={{ height: APP_SHELL_STYLE.height }}>
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
  const onLogout = useTerminalLogoutAction(agents.handleLogout);
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
      roseActions={{
        onCreateAgentInProject: agents.handleCreateNewAgentInProject,
        newAgentProjectId: agents.newAgentProjectId,
        newAgentFolderId: agents.newAgentFolderId,
      }}
      onRefreshAgents={agents.loadAgents}
      onRefreshAttention={onRefreshAttention}
      attentionAgentIds={attentionAgentIds}
      user={agents.user}
      onLogout={onLogout}
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
