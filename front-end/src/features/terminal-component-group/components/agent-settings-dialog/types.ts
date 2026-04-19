/**
 * Shared props/types for AgentSettingsDialog + its sub-components.
 */

import type { AgentDetail } from '../../hooks';

export interface AgentSettingsDialogProps {
  agent: AgentDetail | null;
  onUpdate?: () => void;
  onDelete?: () => void;
}

export interface ModalPosition {
  bottom: number;
  right: number;
}
