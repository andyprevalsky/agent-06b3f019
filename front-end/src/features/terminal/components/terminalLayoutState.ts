/** Derived terminal state + the props shared by TerminalContent's layout components. */
import { useMemo } from 'react';

import type { useAppData } from '@/hooks/appDataContext';
import { isAdminOperator } from '@/lib/adminAccounts';

import {
  computeActiveBrowserPanels,
  derivePendingApproval,
  derivePendingGates,
  deriveHasActiveAttentionRequest,
} from '../hooks/derivations';
import type { useDrippiness } from '../hooks/useDrippiness';
import type { usePatternOffset } from '../hooks/usePatternOffset';
import type { useTerminalAgents } from '../hooks/useTerminalAgents';
import type { useTileAnimation } from '../hooks/useTileAnimation';
import type { TerminalView } from '../types';

export function useTerminalDerivedState(agents: ReturnType<typeof useTerminalAgents>) {
  const activeBrowserPanels = useMemo(
    () => computeActiveBrowserPanels(agents.messages),
    [agents.messages],
  );
  const pendingApproval = useMemo(() => derivePendingApproval(agents.messages), [agents.messages]);
  const pendingGates = useMemo(() => derivePendingGates(agents.messages), [agents.messages]);
  const hasActiveAttention = useMemo(
    () => deriveHasActiveAttentionRequest(agents.messages),
    [agents.messages],
  );
  const browserStatusProps = useMemo(
    () => (activeBrowserPanels.length === 0 ? null : { browsers: activeBrowserPanels }),
    [activeBrowserPanels],
  );
  return {
    pendingApproval,
    pendingGates,
    hasActiveAttention,
    browserStatusProps,
    systemMessages: agents.messages.filter((message) => message.role === 'SYSTEM'),
    showAdminHealth: isAdminOperator(agents.user),
    hasUserMessage:
      agents.selectedAgentId !== null && agents.messages.some((message) => message.role === 'USER'),
  };
}

export interface TerminalLayoutProps {
  agents: ReturnType<typeof useTerminalAgents>;
  drip: ReturnType<typeof useDrippiness>;
  tileAnimation: ReturnType<typeof useTileAnimation>;
  patternOffset: ReturnType<typeof usePatternOffset>['patternOffset'];
  tileColors: ReturnType<typeof usePatternOffset>['tileColors'];
  colorPalette: ReturnType<typeof usePatternOffset>['colorPalette'];
  currentView: TerminalView;
  setCurrentView: (view: TerminalView) => void;
  models: ReturnType<typeof useAppData>['models'];
  modelsLoading: boolean;
  derived: ReturnType<typeof useTerminalDerivedState>;
}
