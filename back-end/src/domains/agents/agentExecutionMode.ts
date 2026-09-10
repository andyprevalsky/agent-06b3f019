import type { CreateAgentBody } from './types';
import { isNonRealWorldModelMode, normalizeWorldModelMode } from '../../providers/worldModelMode';
import { plannerMemoryEnabledByDefault } from '../../providers/plannerMemoryDefaults';
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
 * Apply Fast Mode button defaults for root agents only.
 * Every root agent defaults the Fast Mode *button* on (LLM provider speed)
 * unless the caller opts out or Simulator mode forces it off. DEMO-prompt
 * cache replay is independent of this flag.
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

/** A sub-agent inherits the Fast Mode button from its parent unless explicitly set. */
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

/** A sub-agent inherits planner memory from its parent unless explicitly set. */
export function applyMemoryInheritance(
  body: CreateAgentBody,
  parentMemoryEnabled: boolean | null | undefined
): void {
  if (
    body.memory_enabled === undefined &&
    body.parent_agent_id !== undefined &&
    typeof parentMemoryEnabled === 'boolean'
  ) {
    body.memory_enabled = parentMemoryEnabled;
  }
}

/**
 * New production roots use planner memory by default. Benchmark roots stay off
 * unless their task explicitly opts into the memory A/B arm; descendants then
 * inherit the resolved value from their parent.
 */
export function applyMemoryDefault(body: CreateAgentBody, isBenchmark = false): void {
  if (body.memory_enabled === undefined) {
    body.memory_enabled = plannerMemoryEnabledByDefault(isBenchmark);
  }
}

/** Simulation is authoritative; never let real-provider cache reads bypass WMH. */
export function disableFastModeForWorldModel(body: CreateAgentBody): void {
  if (isNonRealWorldModelMode(body.world_model_mode)) body.fast_mode_cache_enabled = false;
}
