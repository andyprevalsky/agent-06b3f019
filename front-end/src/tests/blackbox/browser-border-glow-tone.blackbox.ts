import { describe, expect, it } from 'vitest';
import { resolveBrowserBorderGlowTone } from '@/features/terminal-component-group/components/browserBorderGlow/resolveTone';
import {
  CHALLENGE_RECOVERY_GLOW_TONE,
  DEFAULT_GLOW_TONE,
  glowToneColors,
} from '@/features/terminal-component-group/components/browserBorderGlow/tones';
import type { Message } from '@/features/terminal-component-group/hooks';

function msg(
  taskId: string,
  overrides: Record<string, unknown> = {},
): Message {
  return {
    message_id: `m-${Math.random()}`,
    role: 'TOOL',
    text: 'recovering',
    timestamp: new Date().toISOString(),
    metadata: {
      task_id: taskId,
      action_type: 'browser_challenge_recovery',
      toolStatus: 'IN_PROGRESS',
      recoveryStage: 'captcha_solver',
      ...overrides,
    },
  };
}

describe('browser border glow challenge-recovery tone', () => {
  it('stays default when no recovery messages exist', () => {
    expect(resolveBrowserBorderGlowTone([], 'task-1')).toBe('default');
    expect(glowToneColors('default')).toBe(DEFAULT_GLOW_TONE);
  });

  it('switches to orange while recover_from_challenge is IN_PROGRESS', () => {
    const messages = [msg('task-1')];
    expect(resolveBrowserBorderGlowTone(messages, 'task-1')).toBe('challenge_recovery');
    expect(glowToneColors('challenge_recovery')).toBe(CHALLENGE_RECOVERY_GLOW_TONE);
  });

  it('ignores recovery for other tasks and completed stages', () => {
    const messages = [
      msg('other-task'),
      msg('task-1', { recoveryStage: 'complete', toolStatus: 'FINISHED' }),
    ];
    expect(resolveBrowserBorderGlowTone(messages, 'task-1')).toBe('default');
  });

  it('uses the newest recovery message for the task', () => {
    const messages = [
      msg('task-1', { recoveryStage: 'complete', toolStatus: 'FINISHED' }),
      msg('task-1', { recoveryStage: 'browser_config_search', toolStatus: 'IN_PROGRESS' }),
    ];
    expect(resolveBrowserBorderGlowTone(messages, 'task-1')).toBe('challenge_recovery');
  });
});
