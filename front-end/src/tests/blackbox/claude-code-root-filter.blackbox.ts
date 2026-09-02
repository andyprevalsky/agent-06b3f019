/**
 * Root transcript filter must keep Claude Code chip anchors even when they
 * carry `subAgentId` (sandbox task_id), otherwise toolCallId dedupe lands on
 * the bare handler cancel and the chip stays on Spinning up.
 */
import { describe, it, expect } from 'vitest';
import {
  filterMessagesForSubAgent,
  isClaudeCodeChipAnchor,
} from '@/features/terminal-component-group/components/useMessageFiltering';
import type { Message } from '@/lib/api';

function toolMsg(
  overrides: Partial<Message> & { metadata: NonNullable<Message['metadata']> },
): Message {
  return {
    message_id: overrides.message_id ?? 'm1',
    timestamp: overrides.timestamp ?? '2026-08-31T23:54:00.000Z',
    text: overrides.text ?? '',
    role: 'TOOL',
    metadata: overrides.metadata,
  };
}

describe('Claude Code root transcript filter', () => {
  it('treats started/complete Claude Code rows as chip anchors', () => {
    expect(
      isClaudeCodeChipAnchor(
        toolMsg({
          metadata: {
            toolName: 'spawn_claude_code_agent',
            action_type: 'task_complete',
            subAgentId: 'task-1',
          },
        }),
      ),
    ).toBe(true);
    expect(
      isClaudeCodeChipAnchor(
        toolMsg({
          metadata: {
            toolName: 'spawn_claude_code_agent',
            action_type: 'agent_observation',
            subAgentId: 'task-1',
          },
        }),
      ),
    ).toBe(false);
  });

  it('keeps Session Cancelled with subAgentId on the root transcript', () => {
    const toolCallId = 'tc-root-filter';
    const heartbeat = toolMsg({
      message_id: 'm-hb',
      metadata: {
        toolCallId,
        toolName: 'spawn_claude_code_agent',
        action_type: 'agent_observation',
        task_id: 'task-1',
        subAgentId: 'task-1',
        toolStatus: 'FINISHED',
        title: 'Claude Code working (571s)',
      },
    });
    const bareCancel = toolMsg({
      message_id: 'm-bare',
      metadata: {
        toolCallId,
        toolName: 'spawn_claude_code_agent',
        action_type: 'task_complete',
        toolStatus: 'ERROR',
        title: 'Claude Code Session Cancelled',
      },
    });
    const sessionCancelled = toolMsg({
      message_id: 'm-cancel',
      metadata: {
        toolCallId,
        toolName: 'spawn_claude_code_agent',
        action_type: 'task_complete',
        task_id: 'task-1',
        subAgentId: 'task-1',
        toolStatus: 'FINISHED',
        title: 'Session Cancelled',
      },
    });

    const rootVisible = filterMessagesForSubAgent(
      [heartbeat, bareCancel, sessionCancelled],
      undefined,
    );
    const titles = rootVisible.map((m) => m.metadata?.title);
    expect(titles).toContain('Session Cancelled');
    expect(titles).toContain('Claude Code Session Cancelled');
    expect(titles).not.toContain('Claude Code working (571s)');
  });
});
