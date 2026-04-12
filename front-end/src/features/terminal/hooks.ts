/**
 * Terminal feature — business logic hooks.
 *
 * Orchestrates API calls, manages derived state, and exposes clean
 * interfaces to components. No JSX rendering here.
 */

export { useOpeningAnimation } from './hooks/useOpeningAnimation';
export { useDrippiness } from './hooks/useDrippiness';
export { useTileAnimation } from './hooks/useTileAnimation';
export { useTickerCarousel } from './hooks/useTickerCarousel';
export { useTerminalAgents } from './hooks/useTerminalAgents';
export { useTerminalMessages } from './hooks/useTerminalMessages';
export { useQuickQuery } from './hooks/useQuickQuery';
export { usePatternOffset } from './hooks/usePatternOffset';
export {
  getModelContextWindow,
  getContextPercentage,
  deduplicateToolMessages,
  sortAgents,
  computeActiveBrowserPanels,
  derivePendingApproval,
  deriveHasActiveAttentionRequest,
} from './hooks/derivations';
