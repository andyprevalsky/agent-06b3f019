/**
 * Shim — the AgentPayModal feature lives at
 * `ui/features/agent-pay-modal/`.
 *
 * This re-export is retained because existing blackbox tests reference this
 * path directly (`import AgentPayModal from '../../ui/components/AgentPayModal'`).
 * Once those tests move to the new path this file can be deleted.
 */

export { default } from '../features/agent-pay-modal';
