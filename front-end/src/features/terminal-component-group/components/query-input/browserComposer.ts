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

/**
 * Browser steps run on the owner agent's Rose pool; a non-Rose owner model uses
 * the dedicated browser pool. Mirrors `browser_pool_for_agent_model`
 * (agents/domains/spawn_browser_agent_v3/config.py) + `pool_for_model`
 * (agents/providers/rose/legacy_adapter.py), shown in the composer's short
 * pool-name style (rose-flash / rose-ultra). The served provider leg (e.g.
 * "qwen-3.8-27b") is never displayed.
 */
export function browserRosePoolLabel(ownerModel: string | null | undefined): string | null {
  if (typeof ownerModel !== 'string' || ownerModel.trim() === '') return null;
  const model = ownerModel.trim().toLowerCase();
  const rose = model.includes('rose-labs') || model === 'rose' || model.startsWith('rose-');
  if (!rose || model.includes('browser-use')) return 'rose-browser-use';
  if (model.includes('local')) return 'rose-local';
  if (model.includes('oss')) return 'rose-oss';
  if (model.includes('ultra')) return 'rose-ultra';
  if (model.includes('mini')) return 'rose-mini';
  return 'rose-flash';
}

/** The task's reported Rose pool labels it; older rows fall back to the owner-model rule. */
export function browserComposerModel(
  apps: RoseAppsValue | null,
  agentId: string | undefined,
  ownerModel: string | null | undefined,
): string {
  const target = browserComposerTarget(apps, agentId);
  const reported = apps?.tabs.find(
    (tab) => tab.agentId === target?.dataset.agentId && tab.taskId === target?.dataset.taskId,
  )?.rosePool;
  return (
    (reported ? browserRosePoolLabel(`rose-labs/${reported}`) : null) ??
    browserRosePoolLabel(ownerModel) ??
    'Model unavailable'
  );
}
