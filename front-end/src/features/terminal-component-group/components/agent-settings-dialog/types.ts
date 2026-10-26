/**
 * Shared props/types for AgentSettingsDialog + its sub-components.
 */

import type { AgentDetail } from '../../hooks';

export interface AgentSettingsDialogProps {
  agent: AgentDetail | null;
  onUpdate?: () => void;
  onDelete?: () => void;
  /** 'nub' = bare white gear with an instant tooltip on the Rose Desktop tab. */
  variant?: 'icon' | 'nub';
}

/** Which trigger edge the panel aligns to: 'start' = left (opens rightward). */
export type ModalAlign = 'start' | 'end';

/** Fixed-position offsets in px; the unused horizontal side is 'auto'. */
export interface ModalPosition {
  bottom: number;
  left: number | 'auto';
  right: number | 'auto';
}
