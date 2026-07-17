/**
 * STATE MACHINE: ChatScrollArea
 *
 * LOADER:
 *   NO_AGENT_OR_EMPTY_MESSAGES → centered opening animation / network loader
 *   HAS_MESSAGES               → dim loader and show message list
 *
 * MOBILE LAYOUT:
 *   OPENING_ANIMATION → centered inside the chat area above the input stack
 *   MOBILE_LOADER     → keeps the desktop ASCII scale and positions below the header
 *   MOBILE_ASCII      → visual-only transform, no layout shift for text/input
 *   MESSAGE_LIST      → normal scrollable message area
 */

import { ScrollArea } from '@/components/ui/scroll-area';
import { AsciiLoader } from '@/features/terminal-component-group';
import { MessageList } from '@/features/terminal-component-group';

import { useOpeningAnimation } from '../hooks/useOpeningAnimation';
import type { AgentSlice, DripSlice, DripStyles } from '../types';

import { OpeningMessageDisplay } from './OpeningMessageDisplay';

interface ChatScrollAreaProps {
  agents: AgentSlice;
  drip: DripSlice;
  opening: ReturnType<typeof useOpeningAnimation>;
  messagesEndRef: React.RefObject<HTMLDivElement>;
}

export function ChatScrollArea({ agents: a, drip, opening, messagesEndRef }: ChatScrollAreaProps) {
  const showLoader = !a.selectedAgentId || a.messages.length === 0;
  const showNetworkDots =
    a.isLoadingNetwork ||
    a.isLoadingAgent ||
    (a.selectedAgentId && a.agentDetail?.status === 'STARTING_UP');

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
      <div className="h-24" />
      {a.selectedAgentId && a.agentDetail?.parent_agent_id && <div className="h-14" />}

      <div
        data-testid="terminal-opening-loader"
        className="pointer-events-none absolute inset-x-0 bottom-0 top-16 flex items-center justify-center transition-all duration-700 ease-in-out md:inset-0 md:h-[100dvh]"
        style={{
          opacity: showLoader ? 1 : 0.2,
          transform: showLoader ? 'translateY(0)' : 'translateY(8px)',
          zIndex: 18,
        }}
      >
        <div className="space-y-6 text-center md:mb-[20vh]">
          <div
            data-testid="terminal-opening-ascii-transform"
            className="translate-y-[5%] scale-95 md:translate-y-0 md:scale-100"
          >
            <AsciiLoader showWarmingUp={false} size="large" variant="engine" />
          </div>
          {showLoader && (
            <div className="-mt-3">
              {!a.selectedAgentId ||
              a.isLoadingAgent ||
              (a.selectedAgentId && a.agentDetail?.status === 'STARTING_UP') ? (
                showNetworkDots ? (
                  <p className="text-muted-foreground">Loading AI Network{a.loadingDots}</p>
                ) : (
                  <OpeningMessageDisplay
                    currentMessageIndex={opening.currentMessageIndex}
                    animationPhase={opening.animationPhase}
                    revealProgress={opening.revealProgress}
                    onJoinWaitlist={a.handleJoinWaitlist}
                  />
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

function BlurOverlay({
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
