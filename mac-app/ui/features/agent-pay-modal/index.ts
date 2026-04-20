/**
 * Public API barrel for the agent-pay-modal feature.
 *
 * Only `AgentPayModal` crosses the feature boundary — it is the sole
 * consumer handle used by its parent (Settings modal flow) and the shim
 * at `ui/components/AgentPayModal.tsx` kept for existing blackbox tests.
 * All other layer files (types, config, api, hooks, components/*) are
 * feature-internal.
 */

export { default } from './components/AgentPayModal';
export { default as AgentPayModal } from './components/AgentPayModal';
