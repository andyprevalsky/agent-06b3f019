/**
 * Background spawn rows (spawn_agent `run_in_background`).
 *
 * The backend posts a background spawn's UI rows in main's shapes under the
 * ORIGINAL toolCallId with `excludeFromModel: true` (the model-facing
 * "Started…" row is `hidden` and never renders).
 *
 * STATES (per row):
 * [IN_PROGRESS excludeFromModel row] -- parent keeps thinking --> kept (never
 *   reaped as an orphaned in-progress tool; the spawn is still running)
 */
import type { Message } from '../api';

/** True for a TOOL row whose progress belongs to a background spawn. */
export function isBackgroundSpawnRow(message: Message): boolean {
  return message.role === 'TOOL' && message.metadata?.excludeFromModel === true;
}
