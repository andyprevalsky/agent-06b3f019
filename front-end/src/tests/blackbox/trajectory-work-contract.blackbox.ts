import { describe, expect, it } from 'vitest';
import { groupTrajectoryWork } from '@/features/terminal-component-group/components/trajectoryWorkGroups';
import { withLiveTrajectory } from '@/features/terminal-component-group/components/trajectoryLiveMessages';
import { msg } from './code-agent-steering.fixtures';
const comm = (id: string, row = id) =>
  msg(
    {
      a2a: {
        message_id: id,
        kind: 'message',
        from: { id: 'root', kind: 'agent', label: 'Rose' },
        to: { id: 'worker', kind: 'agent', label: 'Worker' },
        text: 'Same text',
      },
    },
    { message_id: row, role: 'USER' },
  );
const final = msg(
  { toolName: 'send_message_to_user', isUserAttentionMessage: true },
  { text: 'Done' },
);
describe('ordered work projection boundaries', () => {
  it('never deduplicates distinct exchange identities by equal text', () => {
    const groups = groupTrajectoryWork([comm('one'), comm('two')], 'COMPLETED');
    expect([...groups.groupsByLeadId.values()][0].activities).toHaveLength(2);
  });
  it('does not create a second slot for a late mirror after a user-facing result', () => {
    const groups = groupTrajectoryWork([comm('one'), final, comm('one', 'late-mirror')], 'ACTIVE');
    expect(groups.groupsByLeadId.size).toBe(1);
    expect(groups.foldedIds.has('late-mirror')).toBe(true);
  });
  it('leaves approvals, pinned questions, media and failures outside the history', () => {
    const boundary = [
      msg({ toolName: 'request_user_approval' }),
      msg({ toolName: 'display' }),
      msg({ toolName: 'execute', toolStatus: 'ERROR' }),
    ];
    for (const message of boundary) {
      const groups = groupTrajectoryWork([comm('one'), message], 'ACTIVE');
      expect(groups.foldedIds.has(message.message_id)).toBe(false);
      expect([...groups.groupsByLeadId.values()][0].status).not.toBe('running');
    }
  });
  it('stream-to-canonical handoff retains its slot identity and shows one tool', () => {
    const tool = {
      tool_call_id: 'call',
      stream_id: 'stream',
      tool_name: 'read_file',
      title: 'Read the notes',
    };
    const live = groupTrajectoryWork(withLiveTrajectory([], [tool], false), 'ACTIVE');
    const saved = msg({ toolName: 'read_file', toolCallId: 'call' }, { message_id: 'saved' });
    const canonical = groupTrajectoryWork(withLiveTrajectory([saved], [tool], false), 'ACTIVE');
    expect([...live.groupsByLeadId.values()][0].key).toBe(
      [...canonical.groupsByLeadId.values()][0].key,
    );
    expect([...canonical.groupsByLeadId.values()][0].activities).toHaveLength(1);
  });
  it('does not append stale thinking after a final answer or any terminal status', () => {
    expect(withLiveTrajectory([final], [], true)).toEqual([final]);
    for (const status of ['COMPLETED', 'FAILED', 'PAUSED'])
      expect(withLiveTrajectory([], [], true, undefined, status)).toEqual([]);
  });
});
