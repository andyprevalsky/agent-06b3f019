import type { AgentSpeed } from './rose/speed';

/**
 * Agent speed → Codex's native service tier.
 *
 *   standard   → standard   (no service tier)
 *   fast       → priority   (Codex "Fast")
 *   ultrafast  → ultrafast  (Codex "Ultrafast")
 *
 * Codex never uses the DEMO / Fast Mode cache; speed only picks its tier.
 */
export type CodexServiceSpeed = 'standard' | 'priority' | 'ultrafast';

export function codexSpeedFor(speed: AgentSpeed): CodexServiceSpeed {
  if (speed === 'ultrafast') return 'ultrafast';
  return speed === 'fast' ? 'priority' : 'standard';
}
