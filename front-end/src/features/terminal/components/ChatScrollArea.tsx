/**
 * STATE MACHINE: ChatScrollArea
 *
 * LOADER:
 *   NO_AGENT_OR_EMPTY_MESSAGES → centered opening animation / network loader
 *   HAS_MESSAGES               → dim loader and show message list
 *
 * MOBILE LAYOUT:
 *   OPENING_ANIMATION → centered inside the chat area above the input stack
 *   MOBILE_LOADER     → keeps the desktop ASCII scale and starts below the
 *                       full safe-area-aware mobile header
 *   MOBILE_CAPTION    → opening caption sits inside the large grid tile (phone only)
 *   MOBILE_ASCII      → visual-only transform, no layout shift for text/input
 *   MESSAGE_LIST      → normal scrollable message area
 */

import { ScrollArea } from '@/components/ui/scroll-area';
import { AsciiLoader } from '@/features/terminal-component-group';
import { MessageList } from '@/features/terminal-component-group';

import { useOpeningAnimationState, type OpeningAnimationStore } from '../hooks/useOpeningAnimation';
import type { AgentSlice, DripSlice, DripStyles } from '../types';

import { OpeningMessageDisplay } from './OpeningMessageDisplay';

interface ChatScrollAreaProps {
  agents: AgentSlice;
  drip: DripSlice;
  opening: OpeningAnimationStore;
  messagesEndRef: React.RefObject<HTMLDivElement>;
}

/** Phone only: the caption is anchored inside the large grid tile (429px square
 * centered at 40% of the shell), 5.5rem above its bottom edge; the loader box
 * starts below the mobile header, so that offset is subtracted. On desktop the
 * caption keeps its November 3 position: half the original gap below the art
 * edge, with its own half-height subtracted. It stays out of flow so the art
 * remains independently centered. */
/** Phone only: the art is absolutely centered 2.5rem above the large tile's
 * center (tile = 429px square at 40% of the shell; the loader box starts below
 * the mobile header, so that offset is subtracted), leaving the tile's lower
 * band to the caption. Short phones shrink it with a transform (no CSS zoom,
 * which would also scale the offsets). md+ keeps the original centering. */
const OPENING_ASCII_CLASS =
  'relative scale-95 max-md:absolute max-md:left-1/2 max-md:top-[calc(0.4*var(--app-height,100dvh)-var(--mobile-terminal-header-height)-2.5rem)] max-md:-translate-x-1/2 max-md:-translate-y-1/2 max-md:[@media(max-height:720px)]:scale-[0.68] md:translate-y-0 md:scale-100';

const OPENING_CAPTION_SLOT_CLASS =
  '-mt-3 max-md:absolute max-md:inset-x-0 max-md:top-[calc(0.4*var(--app-height,100dvh)+214.5px-var(--mobile-terminal-header-height)-5.5rem)] max-md:!mt-0 md:absolute md:left-1/2 md:top-full md:!mt-3 md:-translate-x-1/2 md:-translate-y-1/2';

/** Render messages and the responsive empty-chat opening inside the shared scroll area. */
export function ChatScrollArea({ agents: a, drip, opening, messagesEndRef }: ChatScrollAreaProps) {
  const showLoader = !a.selectedAgentId || a.messages.length === 0;
  const showNetworkDots =
    a.isLoadingNetwork ||
    a.isLoadingAgent ||
    (a.selectedAgentId && a.agentDetail?.status === 'STARTING_UP');
  const showOpeningState =
    !a.selectedAgentId ||
    a.isLoadingAgent ||
    (a.selectedAgentId && a.agentDetail?.status === 'STARTING_UP');
  // Only show the waitlist CTA to logged-out / anonymous-bootstrap visitors.
  // A real signed-in account (authenticated AND non-anonymous) is "logged in"
  // and should not see it.
  const showWaitlistCta = !(a.isAuthenticated && !a.isAnonymous);
  const showJoinWaitlistCta = showWaitlistCta && showLoader && showOpeningState && !showNetworkDots;

  return (
    <ScrollArea
      className="flex-1 px-2 md:px-6 relative"
      style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}
    >
      <BlurOverlay
        selectedAgentId={a.selectedAgentId}
        dripStyles={drip.dripStyles}
        blur={drip.blur}
      />
      <div className="h-[var(--mobile-terminal-header-height)] md:h-24" />
      {a.selectedAgentId && a.agentDetail?.parent_agent_id && <div className="h-14" />}

      {/* The grid is viewport-centered; the desktop chat column can be inset by
          the sidebar, so the opening art must use the viewport too. */}
      <div
        data-testid="terminal-opening-loader"
        className="pointer-events-none absolute inset-x-0 bottom-0 top-[var(--mobile-terminal-header-height)] flex items-center justify-center transition-all duration-700 ease-in-out md:fixed md:inset-0 md:h-[100dvh]"
        style={{
          opacity: showLoader && showWaitlistCta ? 1 : 0.2,
          transform: showLoader ? 'translateY(0)' : 'translateY(8px)',
          zIndex: 18,
        }}
      >
        <div className="space-y-6 text-center md:relative md:mb-[20vh]">
          <div data-testid="terminal-opening-ascii-transform" className={OPENING_ASCII_CLASS}>
            <AsciiLoader
              showWarmingUp={false}
              size="large"
              variant="engine"
              cta={
                showJoinWaitlistCta
                  ? { label: 'Join Waitlist', onClick: a.handleJoinWaitlist }
                  : undefined
              }
            />
          </div>
          {showLoader && (
            <div data-testid="terminal-opening-caption-slot" className={OPENING_CAPTION_SLOT_CLASS}>
              {!a.selectedAgentId ||
              a.isLoadingAgent ||
              (a.selectedAgentId && a.agentDetail?.status === 'STARTING_UP') ? (
                showNetworkDots ? (
                  <p className="text-muted-foreground">Loading AI Network{a.loadingDots}</p>
                ) : (
                  <OpeningCaption opening={opening} />
                )
              ) : null}
            </div>
          )}
        </div>
      </div>

      <div
        className="relative min-w-0 max-w-full transition-opacity duration-700 ease-in-out"
        style={{ opacity: a.messages.length > 0 ? 1 : 0, zIndex: 20 }}
      >
        <MessageList
          key={a.selectedAgentId ?? 'no-agent'}
          onAddCredits={() => a.setShowCreditModal(true)}
          onIncreaseCostLimit={() => a.setShowCostLimitModal(true)}
          onNavigateToAgent={a.handleSelectAgent}
          onSubmitFeedback={a.handleSubmitFeedback}
        />
        <div ref={messagesEndRef} />
      </div>
    </ScrollArea>
  );
}

/** The only subscriber to the opening cycle: its 20ms reveal ticks re-render
 * this caption alone, not the chat column and composer around it. */
function OpeningCaption({ opening }: { opening: OpeningAnimationStore }) {
  const { currentMessageIndex, animationPhase, revealProgress } = useOpeningAnimationState(opening);
  return (
    <OpeningMessageDisplay
      currentMessageIndex={currentMessageIndex}
      animationPhase={animationPhase}
      revealProgress={revealProgress}
    />
  );
}

/** The root transcript's backdrop blur (also behind the code-agent view, AgentChatArea). */
export function BlurOverlay({
  selectedAgentId,
  dripStyles,
  blur,
}: {
  selectedAgentId: string | null;
  dripStyles: DripStyles;
  blur: number;
}) {
  const active = selectedAgentId && blur > 0;
  const filterVal = active
    ? `blur(${dripStyles.blur + 8}px) saturate(${dripStyles.saturation}) brightness(${dripStyles.brightness})`
    : undefined;

  return (
    <div
      data-testid="chat-blur-overlay"
      className="absolute inset-0 pointer-events-none ease-in-out"
      style={{
        backdropFilter: filterVal,
        WebkitBackdropFilter: filterVal,
        maskImage:
          'linear-gradient(to right, transparent 0%, black 15%, black 85%, transparent 100%)',
        WebkitMaskImage:
          'linear-gradient(to right, transparent 0%, black 15%, black 85%, transparent 100%)',
        zIndex: 15,
        transition: 'backdrop-filter 1.8s ease-in-out, -webkit-backdrop-filter 1.8s ease-in-out',
      }}
    />
  );
}
