/**
 * STATE MACHINE: AgentChatArea
 *
 * STATES (derived from props):
 *   NO_AGENT + NO_LOADING    → show opening animation + popular goals
 *   NO_AGENT + LOADING       → show "Loading AI Network..." dots
 *   AGENT_SELECTED + LOADING → show "Loading AI Network..." dots
 *   AGENT_SELECTED + READY   → show message list, query input, browser status
 *
 * INPUT ROUTING:
 *   shared recording / inspection / selected detail loading → omit mutation controls
 *   pendingApproval === null  → show QueryInput
 *   pendingApproval !== null  → replace QueryInput with ApprovalChip
 *
 * TEST OBSERVABILITY:
 *   terminal-input-area[data-chat-mode] mirrors the rendered chat/agent mode
 *   transition without changing interaction or visual behavior.
 *
 * PER-USER UI:
 *   NO_AGENT + published home.dashboard slot → dashboard frame above popular goals
 *   per-user background showing              → query box renders opaque
 *
 * LEGAL LINKS:
 *   About, Privacy, and Terms remain available while chatting.
 */

import { useRef, Suspense, type ComponentType, type ReactNode } from 'react';
import * as analytics from '@/lib/analytics';
import { isBenchmarkSharedView } from '@/lib/benchmarkShare';

import { ApprovalChip } from '@/features/terminal-component-group';
import { QueryInput } from '@/features/terminal-component-group';
import { UserUiSlot, useUserUiOpaqueSurfaces } from '@/features/user-ui';
import { GateStack } from './GateStack';

import { useTickerCarousel } from '../hooks/useTickerCarousel';
import { useOpeningAnimation } from '../hooks/useOpeningAnimation';
import { getContextPercentage, getModelContextWindow } from '../hooks/derivations';
import type {
  AgentSlice,
  DripSlice,
  PendingApproval,
  PendingGate,
  BrowserPanelData,
  Message,
  Model,
} from '../types';

import { ChatScrollArea } from './ChatScrollArea';
import { SubAgentBreadcrumb } from './SubAgentBreadcrumb';
import { SystemMessagesPanel } from './SystemMessagesPanel';
import { PopularGoalsCarousel } from './PopularGoalsCarousel';
import { composerCanSubmit } from './composerCanSubmit';
import { TerminalLegalFooter } from './TerminalLegalFooter';

interface AgentChatAreaProps {
  agents: AgentSlice;
  drip: DripSlice;
  models: Model[];
  modelsLoading: boolean;
  pendingApproval: PendingApproval | null;
  pendingGates: PendingGate[];
  hasActiveAttentionRequest: boolean;
  browserStatusProps: { browsers: BrowserPanelData[] } | null;
  systemMessages: Message[];
  BrowserStatusBarCarousel: ComponentType<{ browsers: BrowserPanelData[] }>;
}

export function AgentChatArea({
  agents: a,
  drip,
  models,
  modelsLoading,
  pendingApproval,
  pendingGates,
  hasActiveAttentionRequest,
  browserStatusProps,
  systemMessages,
  BrowserStatusBarCarousel,
}: AgentChatAreaProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const opening = useOpeningAnimation(a.selectedAgentId, a.isLoadingNetwork);
  const { tickerOffset, tickerRef } = useTickerCarousel(a.selectedAgentId);
  const sharedView = isBenchmarkSharedView();
  const readOnlyMessage = sharedView
    ? 'Read-only benchmark recording'
    : a.inspectionContext
      ? 'Read-only account inspection. Switch to this account to control the agent.'
      : a.selectedAgentId && a.isLoadingAgent
        ? 'Loading agent details. Controls will be available when loading finishes.'
        : null;

  const canSubmit = composerCanSubmit({
    selectedAgentId: a.selectedAgentId,
    pendingGateCount: pendingGates.length,
    hasActiveAttentionRequest,
    status: a.agentDetail?.status,
    isChatMode: a.isChatMode,
  });

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
            <BrowserStatusBarCarousel
              key={a.selectedAgentId ?? 'no-agent'}
              browsers={browserStatusProps.browsers}
            />
          </div>
        </Suspense>
      )}

      {readOnlyMessage !== null ? (
        <ReadOnlyNotice>{readOnlyMessage}</ReadOnlyNotice>
      ) : (
        <InputArea
          agents={a}
          drip={drip}
          models={models}
          modelsLoading={modelsLoading}
          pendingApproval={pendingApproval}
          pendingGates={pendingGates}
          canSubmit={canSubmit}
          tickerOffset={tickerOffset}
          tickerRef={tickerRef}
        />
      )}

      <TerminalLegalFooter />
    </>
  );
}

function ReadOnlyNotice({ children }: { children: ReactNode }) {
  return (
    <div className="relative z-10 pb-8 text-center text-sm text-muted-foreground">{children}</div>
  );
}

interface InputAreaProps {
  agents: AgentSlice;
  drip: DripSlice;
  models: Model[];
  modelsLoading: boolean;
  pendingApproval: PendingApproval | null;
  pendingGates: PendingGate[];
  canSubmit: boolean;
  tickerOffset: number;
  tickerRef: React.RefObject<HTMLDivElement>;
}

function InputArea({
  agents: a,
  drip,
  models,
  modelsLoading,
  pendingApproval,
  pendingGates,
  canSubmit,
  tickerOffset,
  tickerRef,
}: InputAreaProps) {
  // shrink-0: this row is a flex sibling of the flex-1 chat scroll area inside
  // an `overflow-hidden` column. Without it, a tall child (an approval card
  // with a multi-item receipt) is the one that gets squeezed and clipped
  // instead of the scrollable transcript above it.
  return (
    <div
      data-testid="terminal-input-area"
      data-chat-mode={a.isChatMode ? 'true' : 'false'}
      className="relative shrink-0 pb-[calc(0.25rem+var(--safe-area-inset-bottom))] transition-opacity duration-300 ease-in-out md:pb-6"
      style={{
        // A pending gate is actionable (the agent is waiting on the user), so
        // keep it crisp even if the agent row shows FAILED — only dim a truly
        // finished, gate-free view.
        opacity: a.agentDetail?.status === 'FAILED' && pendingGates.length === 0 ? 0.8 : 1,
      }}
    >
      {!a.selectedAgentId && (
        <UserUiSlot name="home.dashboard" autoHeight className="relative z-10 mb-3" />
      )}

      {!a.selectedAgentId && (
        <PopularGoalsCarousel
          tickerOffset={tickerOffset}
          tickerRef={tickerRef}
          onGoalClick={(goal) => {
            analytics.track('goal_typed');
            analytics.track('popular_goal_clicked', { goal });
            a.setMessageInput(goal);
          }}
          dripStyles={drip.dripStyles}
          borderColor={drip.borderColor}
        />
      )}

      {/* Gate cards pin above the input UI regardless of the approval/query toggle. */}
      <GateStack
        pendingGates={pendingGates}
        agentId={a.selectedAgentId}
        onGateHandled={() => {
          if (a.selectedAgentId) void a.refreshAgentDetail(a.selectedAgentId);
        }}
      />

      {pendingApproval ? (
        <ApprovalChip
          pendingApproval={pendingApproval}
          onApprovalHandled={() => {
            if (a.selectedAgentId) void a.refreshAgentDetail(a.selectedAgentId);
          }}
        />
      ) : (
        <ChatQueryInputBox
          agents={a}
          drip={drip}
          models={models}
          modelsLoading={modelsLoading}
          canSubmit={canSubmit}
        />
      )}
    </div>
  );
}

interface ChatQueryInputBoxProps {
  agents: AgentSlice;
  drip: DripSlice;
  models: Model[];
  modelsLoading: boolean;
  canSubmit: boolean;
}

function ChatQueryInputBox({
  agents: a,
  drip,
  models,
  modelsLoading,
  canSubmit,
}: ChatQueryInputBoxProps) {
  const opaqueSurface = useUserUiOpaqueSurfaces();
  return (
    <div className="relative z-10">
      <QueryInput
        opaqueSurface={opaqueSurface}
        value={a.messageInput}
        onChange={a.setMessageInput}
        onSubmit={(attachments) => {
          void a.handleSendMessage(attachments);
        }}
        disabled={a.isSendingMessage}
        placeholder={a.selectedAgentId ? 'Type your message...' : 'Enter any goal'}
        selectedModel={a.selectedModel}
        onModelChange={a.setSelectedModel}
        fastMode={a.fastMode}
        onFastModeChange={a.setFastMode}
        simulatorMode={a.simulatorMode}
        onSimulatorModeChange={a.setSimulatorMode}
        availableModels={models.filter(
          (m) =>
            m.id === 'rose-labs/rose-1-flash' ||
            m.id === 'rose-labs/rose-fast' ||
            m.id === 'rose-labs/rose-1-lite' ||
            m.id === 'rose-labs/rose-1-ultra',
        )}
        modelsLoading={modelsLoading}
        contextPercentage={a.agentDetail ? getContextPercentage(a.agentDetail, models) : 0}
        contextSize={a.agentDetail?.context_size || 0}
        restartThreshold={
          a.agentDetail
            ? Math.round(getModelContextWindow(a.agentDetail.model, models) * 0.8)
            : 100000
        }
        showModelSelector={!a.selectedAgentId}
        dripStyles={drip.dripStyles}
        drippiness={drip.blur}
        agentDetail={a.agentDetail}
        onAgentUpdate={() => {
          if (a.selectedAgentId) void a.refreshAgentDetail(a.selectedAgentId);
        }}
        onAgentDelete={() => {
          a.cleanupAgentState();
          void a.loadAgents();
        }}
        canSubmit={canSubmit}
        onPause={() => {
          void a.handlePauseAgent();
        }}
        isPausing={a.isPausing}
        agentId={a.selectedAgentId || undefined}
        pendingPriceLimitCents={a.pendingPriceLimitCents}
        onPendingPriceLimitChange={a.setPendingPriceLimitCents}
      />
    </div>
  );
}
