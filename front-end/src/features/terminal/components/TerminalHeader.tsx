/**
 * STATE MACHINE: TerminalHeader
 *
 * LAYOUT (by viewport):
 * [DESKTOP >= md] --> floating blur PILL, centered: brand + AttentionInbox bell
 *                     (iPad portrait 768-834 / landscape 1024-1194 included; the
 *                     app icons float top-right, the left rail is 64px)
 * [MOBILE  <  md] stock --> full-width FLUSH bar at y=0:
 *                        left   = brand (logo + Rose)
 *                        center = Research (signed-out stock only; signed-in accounts have
 *                                 no Research/Careers links — UI ledger #14)
 *                        right  = hamburger drawer (signed in) OR Login (signed out)
 * [MOBILE  <  md] Rose Desktop --> transparent row at y=0 (safe-area aware):
 *                        left   = hamburger (40px; opens the agents drawer from
 *                                 the LEFT, the left bar's place)
 *                        center = bell and the four app actions (40px targets)
 *                        far right = Rose icon (40px target)
 *                        fits 320-744px without overlap; light + dark
 *
 * MOBILE RIGHT ACTION:
 * [SIGNED_IN]  -- tap hamburger --> MobileAgentDrawer (opens from RIGHT; Agents +
 *                                   Notifications tabs; unanswered-notif badge
 *                                   trails on the hamburger AND the tab)
 * [SIGNED_OUT] -- tap Login ------> parent PhoneAuthModal opens
 *
 * THEME (useRoseTheme; Rose Desktop dark mode):
 * [LIGHT] --> stock pill classes (left-1/2, no right-bar inset since UI
 *             ledger row 66), unchanged by dark mode
 * [DARK]  --> desktop pill adds dark: classes: dark glass rgba(32,32,30,.78)
 *             with light text (overriding the inline drip colours); the
 *             whitish marble layer is hidden
 *
 * Notifications live in the desktop AttentionInbox bell OR the mobile drawer's
 * Notifications tab — never both mount (viewport-branched), so a single
 * useAttentionRequests subscription is active.
 *
 * SYSTEM CONTEXT:
 * mobile tap Login -> onLoginClick -> useTerminalAgents.handleLoginClick
 * -> TerminalModals.loginModalOpen -> PhoneAuthModal -> useAuth.refreshAuthState
 */

import { isStandaloneApp } from '@/lib/isStandaloneApp';
import { useNavigate } from 'react-router-dom';
import type { CSSProperties } from 'react';

import {
  AttentionInbox,
  MobileAgentDrawer,
  RoseAppIcons,
} from '@/features/terminal-component-group';
import type { Agent } from '@/features/terminal-component-group';
import { useRoseDesktop } from '@/hooks/roseDesktopContext';
import { useIsMobile } from '@/hooks/use-mobile';
import { useRoseTheme } from '@/features/rose-theme';
import { cn } from '@/lib/utils';

import type { DripStyles } from '../types';

interface TerminalHeaderProps {
  onCreateNewAgent: () => void;
  onSelectAgent: (agentId: string | null) => void;
  onLoginClick: () => void;
  onLogout: () => void;
  isSignedIn: boolean;
  clientSource: string;
  agents: Agent[];
  isLoadingAgents: boolean;
  hasLoadedAgents: boolean;
  selectedAgentId: string | null;
  onRefreshAgents: () => void | Promise<void>;
  dripStyles: DripStyles;
  blur: number;
  backgroundColors: number;
  borderColor: number;
  shadowIntensity: number;
}

function buildHeaderStyle({
  dripStyles,
  blur,
  backgroundColors,
  borderColor,
  shadowIntensity,
}: Pick<
  TerminalHeaderProps,
  'dripStyles' | 'blur' | 'backgroundColors' | 'borderColor' | 'shadowIntensity'
>): CSSProperties {
  const blurStyle =
    blur > 0
      ? `blur(${dripStyles.blur}px) saturate(${dripStyles.saturation}) brightness(${dripStyles.brightness})`
      : undefined;

  return {
    width: 'min(320px, calc(100vw - 32px))',
    backdropFilter: blurStyle,
    WebkitBackdropFilter: blurStyle,
    backgroundColor:
      backgroundColors > 0 ? `rgba(255, 255, 255, ${dripStyles.bgOpacity})` : undefined,
    borderColor: borderColor > 0 ? dripStyles.borderRgb : undefined,
    boxShadow:
      shadowIntensity > 0
        ? `0 8px 32px rgba(0, 0, 0, ${dripStyles.shadowIntensity}), 0 0 ${dripStyles.glow}px rgba(126, 87, 194, ${dripStyles.glowOpacity}), inset 0 1px 1px rgba(255,255,255,${dripStyles.bgOpacity * 0.5})`
        : undefined,
  };
}

const STOCK_MARBLE_CLASSES = 'absolute inset-0 pointer-events-none';

function MarbleBackground({
  backgroundColors,
  dripStyles,
  isDark,
}: Pick<TerminalHeaderProps, 'backgroundColors' | 'dripStyles'> & { isDark: boolean }) {
  if (backgroundColors <= 0) return null;

  return (
    <div
      className={isDark ? `${STOCK_MARBLE_CLASSES} dark:hidden` : STOCK_MARBLE_CLASSES}
      style={{
        background: `radial-gradient(circle at 10% 20%, rgba(255, 248, 245, ${0.7 * dripStyles.backgroundColorsScalar}) 0%, transparent 40%),
                     radial-gradient(circle at 90% 80%, rgba(248, 245, 255, ${0.6 * dripStyles.backgroundColorsScalar}) 0%, transparent 40%),
                     radial-gradient(circle at 50% 50%, rgba(255, 252, 255, ${0.5 * dripStyles.backgroundColorsScalar}) 0%, transparent 60%)`,
        opacity: 0.3 + dripStyles.backgroundColorsScalar * 0.5,
        zIndex: -1,
      }}
    />
  );
}

function BrandButton({
  onCreateNewAgent,
  compact = false,
}: Pick<TerminalHeaderProps, 'onCreateNewAgent'> & { compact?: boolean }) {
  return (
    <div className="flex items-center space-x-1">
      <button
        type="button"
        onClick={onCreateNewAgent}
        aria-label={compact ? 'Rose' : undefined}
        className={
          compact
            ? 'grid h-10 w-10 place-items-center cursor-pointer hover:opacity-80 transition-opacity'
            : 'flex items-center space-x-2.5 cursor-pointer hover:opacity-80 transition-opacity'
        }
      >
        <div
          className="w-8 h-8 rounded-lg"
          style={{
            background:
              'linear-gradient(to bottom left, #FE7503, #FE7503, #FC585C, #FD5776, #E062CC, #A76CED, #7A6BEC)',
          }}
        />
        {!compact && <span className="text-base font-semibold tracking-tight">Rose</span>}
      </button>
    </div>
  );
}

function SiteNavButtons({
  clientSource,
  isSignedIn,
}: Pick<TerminalHeaderProps, 'clientSource' | 'isSignedIn'>) {
  const navigate = useNavigate();
  const roseDesktop = useRoseDesktop();
  if (clientSource !== 'WEB' || roseDesktop || isSignedIn || isStandaloneApp()) return null;

  return (
    <nav className="flex items-center gap-3 whitespace-nowrap">
      <button
        onClick={() => navigate('/research')}
        className="text-xs sm:text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        Research
      </button>
      <button
        onClick={() => navigate('/careers')}
        className="text-xs sm:text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        Careers
      </button>
    </nav>
  );
}

function HeaderAuthAction({
  isSignedIn,
  onLoginClick,
  onSelectAgent,
}: Pick<TerminalHeaderProps, 'isSignedIn' | 'onLoginClick' | 'onSelectAgent'>) {
  return (
    <>
      {!isSignedIn && (
        <button
          type="button"
          onClick={onLoginClick}
          className="md:hidden flex h-8 items-center justify-center rounded-lg px-3 text-sm font-medium bg-navi-black text-white hover:bg-navi-black/80 transition-colors shadow-sm"
        >
          Login
        </button>
      )}
      <div className={cn(!isSignedIn && 'hidden md:block')}>
        <AttentionInbox onSelectAgent={onSelectAgent} />
      </div>
    </>
  );
}

const STOCK_PILL_CLASSES =
  'absolute top-4 left-1/2 -translate-x-1/2 z-50 flex items-center justify-between p-2 rounded-2xl border border-border/50 dark:border-navi-light-black/50 shadow-lg';

/** Rose dark mode only; `!` beats the inline drip background/border/shadow. */
const ROSE_DARK_PILL_CLASSES =
  'dark:!border-white/[0.08] dark:!bg-[rgba(32,32,30,0.78)] dark:!shadow-[0_6px_20px_rgba(0,0,0,0.35)] dark:text-[#ececea]';

/** Desktop (>= md): the original floating blur pill — brand + AttentionInbox bell. */
function DesktopHeaderPill(props: TerminalHeaderProps) {
  const { onCreateNewAgent, onSelectAgent, onLoginClick, isSignedIn } = props;
  const { dripStyles, blur, backgroundColors, borderColor, shadowIntensity } = props;
  const { isDark } = useRoseTheme();
  return (
    <header
      className={isDark ? `${STOCK_PILL_CLASSES} ${ROSE_DARK_PILL_CLASSES}` : STOCK_PILL_CLASSES}
      style={buildHeaderStyle({ dripStyles, blur, backgroundColors, borderColor, shadowIntensity })}
    >
      <MarbleBackground
        backgroundColors={backgroundColors}
        dripStyles={dripStyles}
        isDark={isDark}
      />
      <BrandButton onCreateNewAgent={onCreateNewAgent} />
      <HeaderAuthAction
        isSignedIn={isSignedIn}
        onLoginClick={onLoginClick}
        onSelectAgent={onSelectAgent}
      />
    </header>
  );
}

/**
 * Mobile (< md): full-width flush bar at y=0.
 * left = brand · center = Research (stock only) · right = hamburger drawer (agents +
 * notifications + login/logout), driving all mobile navigation.
 */
function MobileHeaderBar(props: TerminalHeaderProps) {
  const {
    onCreateNewAgent,
    onSelectAgent,
    onLoginClick,
    onLogout,
    isSignedIn,
    clientSource,
    agents,
    isLoadingAgents,
    selectedAgentId,
    onRefreshAgents,
  } = props;
  return (
    <header className="fixed inset-x-0 top-0 z-50 grid h-[var(--mobile-terminal-header-height)] grid-cols-3 items-center border-b border-border/60 bg-background/85 px-4 pt-[var(--safe-area-inset-top)] backdrop-blur-md">
      <div className="justify-self-start">
        <BrandButton onCreateNewAgent={onCreateNewAgent} />
      </div>
      <div className="justify-self-center">
        <SiteNavButtons clientSource={clientSource} isSignedIn={isSignedIn} />
      </div>
      <div className="flex items-center justify-self-end">
        <MobileAgentDrawer
          agents={agents}
          isLoadingAgents={isLoadingAgents}
          hasLoadedAgents={props.hasLoadedAgents}
          selectedAgentId={selectedAgentId}
          onSelectAgent={onSelectAgent}
          onCreateAgent={onCreateNewAgent}
          onRefreshAgents={onRefreshAgents}
          isSignedIn={isSignedIn}
          onLoginClick={onLoginClick}
          onLogout={onLogout}
        />
      </div>
    </header>
  );
}

/** Rose dark mode only for the mobile pill (light keeps its translucent white). */

/**
 * Rose Desktop mobile (< md): agent menu far left, bell and app actions between,
 * Rose icon far right. The row itself is transparent and lets
 * taps through between its controls.
 */
function RoseMobileHeaderBar(props: TerminalHeaderProps) {
  const { onCreateNewAgent, onSelectAgent, onLoginClick, isSignedIn } = props;
  return (
    <header
      data-testid="rose-mobile-header"
      className="pointer-events-none fixed inset-x-0 top-0 z-50 flex h-[var(--mobile-terminal-header-height)] items-center gap-1 px-1.5 pt-[var(--safe-area-inset-top)]"
    >
      <div className="pointer-events-auto flex-none">
        <MobileAgentDrawer
          roseHeader
          agents={props.agents}
          isLoadingAgents={props.isLoadingAgents}
          hasLoadedAgents={props.hasLoadedAgents}
          selectedAgentId={props.selectedAgentId}
          onSelectAgent={onSelectAgent}
          onCreateAgent={onCreateNewAgent}
          onRefreshAgents={props.onRefreshAgents}
          isSignedIn={isSignedIn}
          onLoginClick={onLoginClick}
          onLogout={props.onLogout}
        />
      </div>
      <div className="pointer-events-auto flex min-w-0 flex-1 items-center justify-end">
        <HeaderAuthAction
          isSignedIn={isSignedIn}
          onLoginClick={onLoginClick}
          onSelectAgent={onSelectAgent}
        />
        <RoseAppIcons placement="header" />
      </div>
      <div data-testid="rose-mobile-pill" className="pointer-events-auto flex-none">
        <BrandButton compact onCreateNewAgent={onCreateNewAgent} />
      </div>
    </header>
  );
}

export function TerminalHeader(props: TerminalHeaderProps) {
  const isMobile = useIsMobile();
  const roseDesktop = useRoseDesktop();
  if (!isMobile) return <DesktopHeaderPill {...props} />;
  return roseDesktop ? <RoseMobileHeaderBar {...props} /> : <MobileHeaderBar {...props} />;
}
