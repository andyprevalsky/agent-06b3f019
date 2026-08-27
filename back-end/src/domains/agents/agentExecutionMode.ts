import type { CreateAgentBody } from './types';
import { isNonRealWorldModelMode, normalizeWorldModelMode } from '../../providers/worldModelMode';
import { isAdminUser } from '../../utils/adminAccess';
export { normalizeWorldModelMode } from '../../providers/worldModelMode';

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

/**
 * Apply Fast Mode defaults for root agents only.
 * Every root agent defaults Fast Mode on unless the caller opts out or Simulator
 * mode forces provider-cache reads off.
 */
export function applyFastModeDefault(body: CreateAgentBody, _userId: string): void {
  if (isNonRealWorldModelMode(body.world_model_mode)) {
    body.fast_mode_cache_enabled = false;
    return;
  }
  if (body.fast_mode_cache_enabled === undefined && body.parent_agent_id === undefined) {
    body.fast_mode_cache_enabled = true;
  }
}

/** A sub-agent inherits Fast Mode from its parent unless explicitly set. */
export function applyFastModeInheritance(
  body: CreateAgentBody,
  parentFastModeCacheEnabled: boolean | null | undefined
): void {
  if (
    body.fast_mode_cache_enabled === undefined &&
    body.parent_agent_id !== undefined &&
    typeof parentFastModeCacheEnabled === 'boolean'
  ) {
    body.fast_mode_cache_enabled = parentFastModeCacheEnabled;
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
