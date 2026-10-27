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
        tab.taskId === target.dataset.taskId &&
        tab.taskId === apps.browserTabTaskId,
    )
  )
    return null;
  return target;
}

/** A missing producer field must stay unknown, not inherit a root-model choice. */
export function browserComposerModel(apps: RoseAppsValue | null, agentId?: string): string {
  const target = browserComposerTarget(apps, agentId);
  return (
    apps?.tabs.find(
      (tab) => tab.agentId === target?.dataset.agentId && tab.taskId === target?.dataset.taskId,
    )?.actualModel ?? 'Model unavailable'
  );
}
