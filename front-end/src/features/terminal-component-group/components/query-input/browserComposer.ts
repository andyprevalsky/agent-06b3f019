/** The Browser slot is presentation for its existing owner-agent message route. */
import type { RoseAppsValue } from '../rose-apps/roseAppsState';

export function browserComposerTarget(apps: RoseAppsValue | null, agentId?: string) {
  const target = apps?.browserComposerSlot;
  if (
    apps?.openApp !== 'browser' ||
    apps.browserMode !== 'remote' ||
    !target ||
    target.dataset.agentId !== apps.selectedAgentId ||
    (agentId !== undefined && agentId !== target.dataset.agentId) ||
    !apps.tabs.some(
      (tab) =>
        tab.agentId === apps.browserTabAgentId &&
        tab.agentId === target.dataset.agentId &&
        tab.taskId === target.dataset.taskId,
    )
  )
    return null;
  return target;
}

// BrowserDecisionStreamer consumes actual_model but publishes only provider-family
// booleans. Neither those flags nor the owner agent's model identify this task's
// actual model, so do not manufacture a model name from the root selection.
export const BROWSER_MODEL_LABEL = 'Model unavailable';
