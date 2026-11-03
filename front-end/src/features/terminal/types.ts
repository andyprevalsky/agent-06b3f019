/**
 * Terminal feature — type definitions.
 *
 * Contains all interfaces, type aliases, and prop types used
 * across the terminal feature layers.
 */

import type {
  Agent,
  AgentDetail,
  Message,
  BlueprintFeedback,
  AncestorNode,
  FilePointer,
  CreateAgentPayload,
  InspectionContext,
  MessageTarget,
} from '@/lib/api';
import type { GateMetadata } from '@/features/terminal-component-group/components/attention-inbox/types';

// ── View state ────────────────────────────────────────────────────────────

export type TerminalView =
  | 'agents'
  | 'browse'
  | 'integrations'
  | 'settings'
  | 'usage'
  | 'network'
  | 'admin-health'
  | 'benchmarks';

export type AnimationPhase = 'revealing' | 'paused' | 'fading';

export interface PendingAgentCreationInput {
  agentId: string;
  goal: string;
  model: string;
  source: AgentDetail['source'];
  priceLimitCents: number;
}

// ── Drip styles ───────────────────────────────────────────────────────────

export interface DripStyles {
  blur: number;
  bgOpacity: number;
  borderOpacity: number;
  shadowIntensity: number;
  glow: number;
  glowOpacity: number;
  saturation: number;
  brightness: number;
  backgroundColorsScalar: number;
  borderColorScalar: number;
  borderRgb: string;
}

export interface DripControls {
  backgroundColors: number;
  blur: number;
  shadowIntensity: number;
  borderColor: number;
}

// ── Browser panel ─────────────────────────────────────────────────────────

export type { BrowserPanelData } from '@/lib/browserPanelLifecycle';

// ── Approval state ────────────────────────────────────────────────────────

export type { PendingApproval } from '@/lib/pendingApproval';

export interface PendingGate {
  attentionRequestId: string;
  gate: GateMetadata;
}

// ── Opening message tuple: [text, pauseDurationMs] ────────────────────────

export type OpeningMessage = [string, number];

// ── Hook return types ─────────────────────────────────────────────────────

export interface TerminalAgentActions {
  loadAgents: () => Promise<void>;
  handleSelectAgent: (agentId: string | null) => void;
  handleCreateAgent: (data: CreateAgentPayload) => Promise<void>;
  handleResumeAgent: (agentId: string) => Promise<void>;
  handlePauseAgent: () => Promise<void>;
  handleSendMessage: (attachments?: FilePointer[], target?: MessageTarget) => Promise<void>;
  handleLogout: () => Promise<void>;
  handleLoginClick: () => void;
  handleCreateNewAgent: () => void;
  /** Rose Desktop project "+": the next goal creates the agent in that project. */
  handleCreateNewAgentInProject: (project: { id: string }, folderId?: string | null) => void;
  handleSubmitFeedback: (feedback: BlueprintFeedback) => Promise<void>;
  refreshAgentDetail: (agentId: string) => Promise<void>;
  cleanupAgentState: () => void;
  resetAnimationState: () => void;
}

export interface TerminalUIState {
  currentView: TerminalView;
  setCurrentView: (view: TerminalView) => void;
  agents: Agent[];
  isLoadingAgents: boolean;
  hasLoadedAgents: boolean;
  createModalOpen: boolean;
  setCreateModalOpen: (open: boolean) => void;
  loginModalOpen: boolean;
  setLoginModalOpen: (open: boolean) => void;
  showCreditModal: boolean;
  setShowCreditModal: (open: boolean) => void;
  showCostLimitModal: boolean;
  setShowCostLimitModal: (open: boolean) => void;
  messageInput: string;
  setMessageInput: (value: string) => void;
  selectedModel: string;
  setSelectedModel: (model: string) => void;
  isSendingMessage: boolean;
  isPausing: boolean;
  resumingAgentId: string | null;
  pendingPriceLimitCents: number;
  setPendingPriceLimitCents: (cents: number) => void;
  isAnyBrowserFullscreen: boolean;
  setIsAnyBrowserFullscreen: (value: boolean) => void;
  ancestors: AncestorNode[];
}

// ── AgentChatArea slices ──────────────────────────────────────────────────

export interface AgentSlice {
  newAgentProjectId?: string | null;
  newAgentFolderId?: string | null;
  isAuthenticated: boolean;
  isAnonymous: boolean;
  handleJoinWaitlist: () => void;
  selectedAgentId: string | null;
  agentDetail: AgentDetail | null;
  inspectionContext?: InspectionContext | null;
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
  fastMode: boolean;
  setFastMode: (enabled: boolean) => void;
  simulatorMode: boolean;
  setSimulatorMode: (enabled: boolean) => void;
  isChatMode: boolean;
  isPausing: boolean;
  ancestors: AncestorNode[];
  handleSelectAgent: (id: string | null) => void;
  handleSendMessage: (attachments?: FilePointer[], target?: MessageTarget) => Promise<void>;
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

export interface DripSlice {
  dripStyles: DripStyles;
  blur: number;
  backgroundColors: number;
  borderColor: number;
  shadowIntensity: number;
}

// ── Re-exports for convenience ────────────────────────────────────────────

export type {
  Agent,
  AgentDetail,
  Message,
  BlueprintFeedback,
  AncestorNode,
  FilePointer,
  CreateAgentPayload,
  MessageTarget,
} from '@/lib/api';

export type { Model } from '@/hooks/useAppData';
