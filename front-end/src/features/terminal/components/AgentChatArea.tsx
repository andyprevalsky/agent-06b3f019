/**
 * STATE MACHINE: AgentChatArea
 *
 * STATES (derived from props):
 *   NO_AGENT + NO_LOADING    → show opening animation + popular goals
 *   NO_AGENT + LOADING       → show "Loading AI Network..." dots
 *   AGENT_SELECTED + LOADING → show "Loading AI Network..." dots
 *   AGENT_SELECTED + READY   → show message list, query input, browser status
 */

import { useRef, Suspense, type ComponentType } from 'react';
import { Link } from 'react-router-dom';
import * as amplitude from '@amplitude/analytics-browser';

import { ScrollArea } from '@/components/ui/scroll-area';
import { AsciiLoader } from '@/features/terminal-component-group';
import { ApprovalChip } from '@/features/terminal-component-group';
import { QueryInput } from '@/features/terminal-component-group';
import { MessageList } from '@/features/terminal-component-group';
import type { AgentDetail, AncestorNode, FilePointer, BlueprintFeedback } from '@/lib/api';

import { useTickerCarousel } from '../hooks/useTickerCarousel';
import { useOpeningAnimation } from '../hooks/useOpeningAnimation';
import { getContextPercentage, getModelContextWindow } from '../hooks/derivations';
import type { PendingApproval, BrowserPanelData, Message, DripStyles, Model } from '../types';

import { SubAgentBreadcrumb } from './SubAgentBreadcrumb';
import { SystemMessagesPanel } from './SystemMessagesPanel';
import { OpeningMessageDisplay } from './OpeningMessageDisplay';
import { PopularGoalsCarousel } from './PopularGoalsCarousel';

interface AgentChatAreaProps {
  agents: AgentSlice;
  drip: DripSlice;
  models: Model[];
  modelsLoading: boolean;
  pendingApproval: PendingApproval | null;
  hasActiveAttentionRequest: boolean;
  browserStatusProps: { browsers: BrowserPanelData[] } | null;
  systemMessages: Message[];
  BrowserStatusBarCarousel: ComponentType<{ browsers: BrowserPanelData[] }>;
}

interface AgentSlice {
  selectedAgentId: string | null;
  agentDetail: AgentDetail | null;
  messages: Message[];
  isLoadingAgent: boolean;
  isLoadingNetwork: boolean;
  loadingDots: string;
  messageInput: string;
  setMessageInput: (v: string) => void;
  isSendingMessage: boolean;
  selectedModel: string;
  setSelectedModel: (m: string) => void;
  pendingPriceLimitCents: number;
  setPendingPriceLimitCents: (c: number) => void;
  isChatMode: boolean;
  isPausing: boolean;
  ancestors: AncestorNode[];
  handleSelectAgent: (id: string | null) => void;
  handleSendMessage: (attachments?: FilePointer[]) => Promise<void>;
  handlePauseAgent: () => Promise<void>;
  handleSubmitFeedback: (f: BlueprintFeedback) => Promise<void>;
  refreshAgentDetail: (id: string) => Promise<void>;
  cleanupAgentState: () => void;
  resetAnimationState?: () => void;
  setShowCreditModal: (v: boolean) => void;
  setShowCostLimitModal: (v: boolean) => void;
  loadAgents: () => Promise<void>;
  forceResubscribeContext: () => void;
}

interface DripSlice {
  dripStyles: DripStyles;
  blur: number;
  backgroundColors: number;
  borderColor: number;
  shadowIntensity: number;
}

export function AgentChatArea({
  agents: a,
  drip,
  models,
  modelsLoading,
  pendingApproval,
  hasActiveAttentionRequest,
  browserStatusProps,
  systemMessages,
  BrowserStatusBarCarousel,
}: AgentChatAreaProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const opening = useOpeningAnimation(a.selectedAgentId, a.isLoadingNetwork);
  const { tickerOffset, tickerRef } = useTickerCarousel(a.selectedAgentId);

  const canSubmit =
    !a.selectedAgentId ||
    hasActiveAttentionRequest ||
    a.agentDetail?.status === 'PAUSED' ||
    a.agentDetail?.status === 'COMPLETED' ||
    a.agentDetail?.status === 'FAILED' ||
    a.agentDetail?.status === 'COST_LIMIT_REACHED' ||
    a.isChatMode;

  return (
    <>
      {a.selectedAgentId && a.agentDetail?.parent_agent_id && (
        <SubAgentBreadcrumb
          ancestors={a.ancestors}
          agentDetail={a.agentDetail}
          onSelectAgent={a.handleSelectAgent}
          dripStyles={drip.dripStyles}
          blur={drip.blur}
        />
      )}

      {a.selectedAgentId && systemMessages.length > 0 && (
        <SystemMessagesPanel messages={systemMessages} />
      )}

      <ChatScrollArea agents={a} drip={drip} opening={opening} messagesEndRef={messagesEndRef} />

      {browserStatusProps && (
        <Suspense fallback={null}>
          <div className="px-2 md:px-0">
            <BrowserStatusBarCarousel browsers={browserStatusProps.browsers} />
          </div>
        </Suspense>
      )}

      <InputArea
        agents={a}
        drip={drip}
        models={models}
        modelsLoading={modelsLoading}
        pendingApproval={pendingApproval}
        canSubmit={canSubmit}
        tickerOffset={tickerOffset}
        tickerRef={tickerRef}
      />

      <div className="absolute bottom-1 left-0 right-0 flex justify-center gap-2 text-[11px] text-muted-foreground/50 z-10">
        <Link to="/privacy" className="hover:text-muted-foreground transition-colors">Privacy</Link>
        <span>&middot;</span>
        <Link to="/terms" className="hover:text-muted-foreground transition-colors">Terms</Link>
      </div>
    </>
  );
}

// ── ChatScrollArea sub-component ────────────────────────────────────────

function ChatScrollArea({
  agents: a,
  drip,
  opening,
  messagesEndRef,
}: {
  agents: AgentSlice;
  drip: DripSlice;
  opening: ReturnType<typeof useOpeningAnimation>;
  messagesEndRef: React.RefObject<HTMLDivElement>;
}) {
  const showLoader = !a.selectedAgentId || a.messages.length === 0;
  const showNetworkDots =
    a.isLoadingNetwork || a.isLoadingAgent || (a.selectedAgentId && a.agentDetail?.status === 'STARTING_UP');

  return (
    <ScrollArea
      className="flex-1 px-2 md:px-6 relative"
      style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}
    >
      <BlurOverlay selectedAgentId={a.selectedAgentId} dripStyles={drip.dripStyles} blur={drip.blur} />
      <div className="h-24" />
      {a.selectedAgentId && a.agentDetail?.parent_agent_id && <div className="h-14" />}

      <div
        className="absolute inset-0 flex items-center justify-center pointer-events-none transition-all duration-700 ease-in-out"
        style={{ opacity: showLoader ? 1 : 0.2, transform: showLoader ? 'translateY(0)' : 'translateY(8px)', zIndex: 18, height: '100dvh' }}
      >
        <div className="text-center space-y-6" style={{ marginBottom: '20vh' }}>
          <AsciiLoader showWarmingUp={false} size="large" variant="engine" />
          {showLoader && (
            <div className="-mt-3">
              {(!a.selectedAgentId || a.isLoadingAgent || (a.selectedAgentId && a.agentDetail?.status === 'STARTING_UP')) ? (
                showNetworkDots ? (
                  <p className="text-muted-foreground">Loading AI Network{a.loadingDots}</p>
                ) : (
                  <OpeningMessageDisplay
                    currentMessageIndex={opening.currentMessageIndex}
                    animationPhase={opening.animationPhase}
                    revealProgress={opening.revealProgress}
                  />
                )
              ) : null}
            </div>
          )}
        </div>
      </div>

      <div className="transition-opacity duration-700 ease-in-out relative" style={{ opacity: a.messages.length > 0 ? 1 : 0, zIndex: 20 }}>
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

// ── BlurOverlay sub-component ───────────────────────────────────────────

function BlurOverlay({ selectedAgentId, dripStyles, blur }: { selectedAgentId: string | null; dripStyles: DripStyles; blur: number }) {
  const active = selectedAgentId && blur > 0;
  const filterVal = active ? `blur(${dripStyles.blur + 8}px) saturate(${dripStyles.saturation}) brightness(${dripStyles.brightness})` : undefined;

  return (
    <div
      className="absolute inset-0 pointer-events-none ease-in-out"
      style={{
        backdropFilter: filterVal, WebkitBackdropFilter: filterVal,
        maskImage: 'linear-gradient(to right, transparent 0%, black 15%, black 85%, transparent 100%)',
        WebkitMaskImage: 'linear-gradient(to right, transparent 0%, black 15%, black 85%, transparent 100%)',
        zIndex: 15, transition: 'backdrop-filter 1.8s ease-in-out, -webkit-backdrop-filter 1.8s ease-in-out',
      }}
    />
  );
}

// ── InputArea sub-component ─────────────────────────────────────────────

function InputArea({
  agents: a,
  drip,
  models,
  modelsLoading,
  pendingApproval,
  canSubmit,
  tickerOffset,
  tickerRef,
}: {
  agents: AgentSlice;
  drip: DripSlice;
  models: Model[];
  modelsLoading: boolean;
  pendingApproval: PendingApproval | null;
  canSubmit: boolean;
  tickerOffset: number;
  tickerRef: React.RefObject<HTMLDivElement>;
}) {
  return (
    <div
      className="pb-6 transition-opacity duration-300 ease-in-out relative"
      style={{ opacity: a.agentDetail?.status === 'FAILED' ? 0.8 : 1 }}
    >
      {!a.selectedAgentId && (
        <PopularGoalsCarousel
          tickerOffset={tickerOffset}
          tickerRef={tickerRef}
          onGoalClick={(goal) => {
            amplitude.track('goal_typed');
            amplitude.track('popular_goal_clicked', { goal });
            a.setMessageInput(goal);
          }}
          dripStyles={drip.dripStyles}
          borderColor={drip.borderColor}
        />
      )}

      <ApprovalChip
        pendingApproval={pendingApproval}
        onApprovalHandled={() => { if (a.selectedAgentId) void a.refreshAgentDetail(a.selectedAgentId); }}
      />

      <div className="relative z-10">
        <QueryInput
          value={a.messageInput}
          onChange={a.setMessageInput}
          onSubmit={(attachments) => { void a.handleSendMessage(attachments); }}
          disabled={a.isSendingMessage}
          placeholder={a.selectedAgentId ? 'Type your message...' : 'Enter any goal'}
          selectedModel={a.selectedModel}
          onModelChange={a.setSelectedModel}
          availableModels={models.filter((m) => m.id === 'rose-labs/rose-1-lite' || m.id === 'rose-labs/rose-1-ultra')}
          modelsLoading={modelsLoading}
          contextPercentage={a.agentDetail ? getContextPercentage(a.agentDetail, models) : 0}
          contextSize={a.agentDetail?.context_size || 0}
          restartThreshold={a.agentDetail ? Math.round(getModelContextWindow(a.agentDetail.model, models) * 0.8) : 100000}
          showModelSelector={!a.selectedAgentId}
          dripStyles={drip.dripStyles}
          drippiness={drip.blur}
          agentDetail={a.agentDetail}
          onAgentUpdate={() => { if (a.selectedAgentId) void a.refreshAgentDetail(a.selectedAgentId); }}
          onAgentDelete={() => { a.cleanupAgentState(); void a.loadAgents(); }}
          canSubmit={canSubmit}
          onPause={() => { void a.handlePauseAgent(); }}
          isPausing={a.isPausing}
          agentId={a.selectedAgentId || undefined}
          pendingPriceLimitCents={a.pendingPriceLimitCents}
          onPendingPriceLimitChange={a.setPendingPriceLimitCents}
        />
      </div>
    </div>
  );
}
