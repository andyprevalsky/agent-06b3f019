/**
 * STATE MACHINE: AgentChatArea
 *
 * STATES (derived from props):
 *   NO_AGENT + NO_LOADING    → show opening animation + composer
 *   NO_AGENT + LOADING       → show "Loading AI Network..." dots
 *   AGENT_SELECTED + LOADING → show "Loading AI Network..." dots
 *   AGENT_SELECTED + READY   → show message list, query input, browser status
 *
 * INPUT ROUTING:
 *   shared recording / inspection / selected detail loading → omit mutation controls
 *   pendingApproval === null  → show QueryInput
 *   pendingApproval !== null  → replace QueryInput with ApprovalChip
 *   Rose Desktop pinned question → PinnedQuestionMount directly above the
 *     approval/query box (renders nothing when flag off or none pending)
 *
 * CODE AGENT VIEW (Rose Desktop, useOpenCodeAgent): a left-bar code-agent row
 *   of the selected (owner) agent is open → CodeAgentConversationView replaces
 *   the whole column (header + transcript over the root's blur backdrop + the
 *   query box as its direct channel); closing it returns to this agent's chat.
 *
 * AGENTS BANNER (BackgroundAgentsBanner, attached to the top of QueryInput):
 *   0 running agents → hidden (brief "All agents finished" after the last one)
 *   N running        → "Running N agents" ⇄ expanded live hierarchy
 *
 * TEST OBSERVABILITY:
 *   terminal-input-area[data-chat-mode] mirrors the rendered chat/agent mode
 *   transition without changing interaction or visual behavior.
 *
 * LEGAL LINKS:
 *   stock         → About, Privacy, and Terms footer remains while chatting.
 *   Rose Desktop  → no footer (UI ledger #14); the links live behind the
 *                   info item of the query box's rose nub.
 *
 * APP VIEW (Rose Desktop only, UI ledger rows 10/39; AppViewProvider):
 *   a code-agent chip's "Open app" button opens that code session's preview,
 *   which replaces the whole chat column (AppScreenHost): the app full screen,
 *   the normal query box floating over it (Popular Goals hidden) steering that
 *   session. Escape / an agent row / Home / New Super Agent close it.
 *
 * MOBILE BOTTOM (Rose Desktop only, UI ledger #11):
 *   the input area pads by --mobile-querybox-gap only and carries
 *   `rose-mobile-query-area`; below md the query box inside it hugs the display
 *   curve (index.css: concentric bottom radius + safe-area inner padding).
 *   stock → input area pads by the safe-area inset (unchanged).
 */

import { useRef, Suspense, type ComponentType, type ReactNode } from 'react';
import { isBenchmarkSharedView } from '@/lib/benchmarkShare';

import {
  ApprovalChip,
  BackgroundAgentsBanner,
  CodeAgentConversationView,
  PinnedQuestionMount,
  QueryInput,
  useAppView,
  useOpenCodeAgent,
} from '@/features/terminal-component-group';
import { useRoseDesktop } from '@/hooks/roseDesktopContext';
import { cn } from '@/lib/utils';
import { GateStack } from './GateStack';

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

import { AppScreenHost } from './AppScreenHost';
import { BlurOverlay, ChatScrollArea } from './ChatScrollArea';
import { SubAgentBreadcrumb } from './SubAgentBreadcrumb';
import { SystemMessagesPanel } from './SystemMessagesPanel';
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

/** Rose Desktop: an open app view (AppViewProvider) replaces the whole chat column. */
export function AgentChatArea(props: AgentChatAreaProps) {
  const roseDesktop = useRoseDesktop();
  const appView = useAppView();
  const target = roseDesktop && !isBenchmarkSharedView() ? (appView?.target ?? null) : null;
  if (target === null || appView === null) return <ChatColumn {...props} />;
  return (
    <AppScreenHost
      target={target}
      onClose={appView.closeApp}
      agents={props.agents}
      drip={props.drip}
    />
  );
}

function ChatColumn({
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
  const roseDesktop = useRoseDesktop();
  const readOnlyMessage = readOnlyNotice(a);

  const codeAgent = useOpenCodeAgent(a.selectedAgentId);
  if (codeAgent !== null) {
    const blur = <BlurOverlay selectedAgentId={a.selectedAgentId} {...drip} />;
    return (
      <CodeAgentConversationView
        key={codeAgent.taskId}
        codeAgent={codeAgent}
        readOnlyMessage={readOnlyMessage}
        backdrop={blur}
      />
    );
  }

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
        />
      )}

      {!roseDesktop && <TerminalLegalFooter />}
    </>
  );
}

function readOnlyNotice(a: AgentSlice): string | null {
  if (isBenchmarkSharedView()) return 'Read-only benchmark recording';
  if (a.inspectionContext) {
    return 'Read-only account inspection. Switch to this account to control the agent.';
  }
  if (a.selectedAgentId && a.isLoadingAgent) {
    return 'Loading agent details. Controls will be available when loading finishes.';
  }
  return null;
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
}

function InputArea({
  agents: a,
  drip,
  models,
  modelsLoading,
  pendingApproval,
  pendingGates,
  canSubmit,
}: InputAreaProps) {
  // shrink-0: this row is a flex sibling of the flex-1 chat scroll area inside
  // an `overflow-hidden` column. Without it, a tall child (an approval card
  // with a multi-item receipt) is the one that gets squeezed and clipped
  // instead of the scrollable transcript above it.
  const roseDesktop = useRoseDesktop();
  return (
    <div
      data-testid="terminal-input-area"
      data-chat-mode={a.isChatMode ? 'true' : 'false'}
      className={cn(
        'relative z-30 shrink-0 transition-opacity duration-300 ease-in-out md:pb-6',
        roseDesktop
          ? 'rose-mobile-query-area pb-[var(--mobile-querybox-gap)]'
          : 'pb-[calc(0.25rem+var(--safe-area-inset-bottom))]',
      )}
      style={{
        // A pending gate is actionable (the agent is waiting on the user), so
        // keep it crisp even if the agent row shows FAILED — only dim a truly
        // finished, gate-free view.
        opacity: a.agentDetail?.status === 'FAILED' && pendingGates.length === 0 ? 0.8 : 1,
      }}
    >
      {/* Gate cards pin above the input UI regardless of the approval/query toggle. */}
      <GateStack
        pendingGates={pendingGates}
        agentId={a.selectedAgentId}
        onGateHandled={() => {
          if (a.selectedAgentId) void a.refreshAgentDetail(a.selectedAgentId);
        }}
      />

      {/* Rose Desktop: a code agent's pinned question sits directly above the query box. */}
      {a.selectedAgentId && <PinnedQuestionMount />}

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
  return (
    <div className="relative z-10">
      <QueryInput
        liftAboveApps
        topAttachment={
          <BackgroundAgentsBanner
            key={a.selectedAgentId ?? 'no-agent'}
            selectedAgentId={a.selectedAgentId}
            messages={a.messages}
            onNavigate={(agentId) => a.handleSelectAgent(agentId)}
          />
        }
        value={a.messageInput}
        onChange={a.setMessageInput}
        onSubmit={(attachments, target) => {
          void a.handleSendMessage(attachments, target);
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
            m.id === 'rose-labs/rose-1-ultra' ||
            m.id === 'rose-labs/rose-local',
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
