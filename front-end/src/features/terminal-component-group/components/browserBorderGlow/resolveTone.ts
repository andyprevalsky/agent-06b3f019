import type { Message } from '../../hooks';
import type { BrowserBorderGlowTone } from './tones';

/**
 * Orange border glow while recover_from_challenge is in flight for this task.
 *
 * Active when the newest browser_challenge_recovery message for the task is
 * still IN_PROGRESS (not complete/failed).
 */
export function resolveBrowserBorderGlowTone(
  messages: Message[],
  taskId: string,
): BrowserBorderGlowTone {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const md = messages[i]?.metadata as Record<string, unknown> | undefined;
    if (!md || md.task_id !== taskId) continue;
    if (md.action_type !== 'browser_challenge_recovery') continue;
    const stage = typeof md.recoveryStage === 'string' ? md.recoveryStage : '';
    if (stage === 'complete' || md.toolStatus === 'FINISHED' || md.toolStatus === 'ERROR') {
      return 'default';
    }
    if (md.toolStatus === 'IN_PROGRESS' || stage.length > 0) {
      return 'challenge_recovery';
    }
  }
  return 'default';
}
