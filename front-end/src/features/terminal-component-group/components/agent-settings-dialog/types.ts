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

export interface ModalPosition {
  bottom: number;
  right: number;
}
