import type { CreateAgentBody } from './types';
import { isNonRealWorldModelMode, normalizeWorldModelMode } from '../../providers/worldModelMode';
import { isAdminUser } from '../../utils/adminAccess';
export { normalizeWorldModelMode } from '../../providers/worldModelMode';
const DEFAULT_FAST_MODE_USER_IDS = new Set(['1f85ff25-6e29-4c1b-8739-f917bd101a30']);

export class WorldModelModeAccessError extends Error {
  constructor() {
    super('Simulator mode requires administrator access');
    this.name = 'WorldModelModeAccessError';
  }
}

/** Non-real provider execution is an admin capability, enforced server-side. */
export function assertWorldModelModeAccess(body: CreateAgentBody, userId: string): void {
  if (isNonRealWorldModelMode(body.world_model_mode) && !isAdminUser(userId)) {
    throw new WorldModelModeAccessError();
  }
}

/** Apply account-scoped Fast Mode defaults for root agents only. */
export function applyFastModeDefault(body: CreateAgentBody, userId: string): void {
  if (isNonRealWorldModelMode(body.world_model_mode)) {
    body.fast_mode_cache_enabled = false;
    return;
  }
  if (
    body.fast_mode_cache_enabled === undefined &&
    body.parent_agent_id === undefined &&
    DEFAULT_FAST_MODE_USER_IDS.has(userId)
  ) {
    body.fast_mode_cache_enabled = true;
  }
}

/** A sub-agent inherits Fast Mode reads from its parent unless explicitly set. */
export function applyFastModeInheritance(
  body: CreateAgentBody,
  parentFastModeCacheEnabled: boolean | null | undefined
): void {
  if (
    body.fast_mode_cache_enabled === undefined &&
    body.parent_agent_id !== undefined &&
    parentFastModeCacheEnabled === true
  ) {
    body.fast_mode_cache_enabled = true;
  }
}

/** A sub-agent inherits its parent's provider/environment execution mode. */
export function applyWorldModelModeInheritance(
  body: CreateAgentBody,
  parentWorldModelMode: string | null | undefined
): void {
  if (body.world_model_mode !== undefined || body.parent_agent_id === undefined) return;
  body.world_model_mode = normalizeWorldModelMode(parentWorldModelMode);
}

/** Simulation is authoritative; never let real-provider cache reads bypass WMH. */
export function disableFastModeForWorldModel(body: CreateAgentBody): void {
  if (isNonRealWorldModelMode(body.world_model_mode)) body.fast_mode_cache_enabled = false;
}
