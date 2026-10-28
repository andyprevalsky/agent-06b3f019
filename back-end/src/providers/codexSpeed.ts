/**
 * Query-box speed → Codex's native service tier.
 *
 *   Fast Mode off           → standard   (no service tier)
 *   Fast Mode on, "fast"    → priority   (Codex "Fast")
 *   Fast Mode on, "ultra"   → ultrafast  (Codex "Ultrafast")
 *
 * Fast Mode on without a recorded speed (API and benchmark callers) is "fast".
 * Codex never uses the DEMO / Fast Mode cache; speed is the only thing the
 * Fast Mode button changes for a Codex session.
 */
export type CodexServiceSpeed = 'standard' | 'priority' | 'ultrafast';

export function codexSpeedFor(
  fastModeEnabled: boolean,
  speed: string | null | undefined
): CodexServiceSpeed {
  if (!fastModeEnabled) return 'standard';
  return speed === 'ultra' ? 'ultrafast' : 'priority';
}
