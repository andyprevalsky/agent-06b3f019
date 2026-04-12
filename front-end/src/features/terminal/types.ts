/**
 * Terminal feature — type definitions.
 *
 * Contains all interfaces, type aliases, and prop types used
 * across the terminal feature layers.
 */

import type {
  Agent,
  BlueprintFeedback,
  AncestorNode,
  FilePointer,
  CreateAgentPayload,
} from '@/lib/api';

// ── View state ────────────────────────────────────────────────────────────

export type TerminalView = 'agents' | 'integrations' | 'settings' | 'usage' | 'network';

export type AnimationPhase = 'revealing' | 'paused' | 'fading';

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

export interface BrowserPanelData {
  taskId: string;
  browserUrl: string;
}

// ── Approval state ────────────────────────────────────────────────────────

export interface PendingApproval {
  attentionRequestId: string;
  question: string;
  imageUrl: string | null;
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
  handleSendMessage: (attachments?: FilePointer[]) => Promise<void>;
  handleLogout: () => Promise<void>;
  handleLoginClick: () => void;
  handleCreateNewAgent: () => void;
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

// ── Re-exports for convenience ────────────────────────────────────────────

export type {
  Agent,
  AgentDetail,
  Message,
  BlueprintFeedback,
  AncestorNode,
  FilePointer,
  CreateAgentPayload,
} from '@/lib/api';

export type { Model } from '@/hooks/useAppData';
