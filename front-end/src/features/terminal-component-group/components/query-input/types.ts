/**
 * Shared types for the QueryInput sub-components.
 *
 * Keeps `QueryInput.tsx` under the 300-line cap by isolating the component
 * contract, attachment lifecycle, and drip-styling shape in one place.
 */
import type React from 'react';

import type { MessageTarget } from '@/lib/api';
import type { SpeedLevel } from '@/lib/agentSpeed';
import type { AgentDetail, FilePointer, Model } from '../../hooks';

/** Single in-flight attachment. Lifecycle: pending -> uploading -> done | error. */
export interface PendingAttachment {
  id: string;
  file: File;
  status: 'pending' | 'uploading' | 'done' | 'error';
  progress: number;
  filePointer?: FilePointer;
  error?: string;
  /** Blob URL for image thumbnails. MUST be revoked on cleanup to avoid leaks. */
  thumbnailUrl?: string;
}

/** Visual-drip styling passed through from the parent theming layer. */
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

export interface QueryInputProps {
  /** Real terminal composers sit above app panels and their icon category. */
  liftAboveApps?: boolean;
  /**
   * Rendered flush on top of the input box (same column + edges), e.g. the
   * "Running N agents" banner. When it renders, the box's top corners square
   * off so the two read as one attached container.
   */
  topAttachment?: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
  /** `target` is set only by the Browser composer: deliver straight to that browser task. */
  onSubmit: (attachments?: FilePointer[], target?: MessageTarget) => void | Promise<boolean>;
  disabled?: boolean;
  placeholder?: string;
  selectedModel?: string;
  onModelChange?: (model: string) => void;
  fastMode?: boolean;
  onFastModeChange?: (enabled: boolean) => void;
  simulatorMode?: boolean;
  onSimulatorModeChange?: (enabled: boolean) => void;
  availableModels?: Model[];
  modelsLoading?: boolean;
  contextPercentage?: number;
  contextSize?: number;
  restartThreshold?: number;
  showModelSelector?: boolean;
  dripStyles?: DripStyles;
  drippiness?: number;
  agentDetail?: AgentDetail | null;
  onAgentUpdate?: () => void;
  onAgentDelete?: () => void;
  canSubmit?: boolean;
  onPause?: () => void;
  isPausing?: boolean;
  agentId?: string;
  pendingPriceLimitCents?: number;
  onPendingPriceLimitChange?: (cents: number) => void;
  /**
   * Rose Desktop code-agent view: native direct delivery with attachments and
   * session controls; excludes the Rose-only nub tab and pinned tools.
   */
  directChannel?: boolean;
  draftKey?: string;
  sessionControls?: React.ReactNode;
  /**
   * The speed toggle's state when the caller owns it (the code-agent view: its
   * session's speed). Without onFastModeChange the toggle only shows the state.
   */
  speedControl?: SpeedControl;
  /**
   * Rose Desktop direct channel: status at the box's top-right corner (the
   * code-agent view's container dot + devbox usage); the text keeps clear of it.
   */
  cornerStatus?: React.ReactNode;
  /** Rose Desktop nub content for a direct channel (the code-agent view's working settings). */
  nub?: React.ReactNode;
}

export const DEFAULT_DRIP_STYLES: DripStyles = {
  blur: 12,
  bgOpacity: 0.8,
  borderOpacity: 0.5,
  shadowIntensity: 0,
  glow: 0,
  glowOpacity: 0,
  saturation: 1.0,
  brightness: 1.0,
  backgroundColorsScalar: 0,
  borderColorScalar: 0,
  borderRgb: 'rgba(255, 255, 255, 0.5)',
};

/** Speed toggle wiring (InputContainer's SpeedToggle). */
export interface SpeedControl {
  fastMode: boolean;
  onFastModeChange?: (enabled: boolean) => void;
  /**
   * The exact level the caller runs at (the code-agent view: its session's
   * standard / fast / ultrafast), shown instead of the account's fast-vs-ultra
   * preference; with it, clicks go to onLevelChange (absent → read-only).
   */
  level?: SpeedLevel;
  onLevelChange?: (level: SpeedLevel) => void;
}
