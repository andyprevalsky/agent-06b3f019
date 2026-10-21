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
  it('leaves pending approvals, pinned questions and media outside the history', () => {
    const boundary = [msg({ toolName: 'request_user_approval' }), msg({ toolName: 'display' })];
    for (const message of boundary) {
      const groups = groupTrajectoryWork([comm('one'), message], 'ACTIVE');
      expect(groups.foldedIds.has(message.message_id)).toBe(false);
      expect([...groups.groupsByLeadId.values()][0].status).not.toBe('running');
    }
  });
  it.each([
    {
      toolName: 'attempt_completion',
      toolStatus: 'ERROR',
      error: true,
      title: '❌ Plan required',
      phase: 'PLAN',
    },
    { toolName: 'read_file', toolStatus: 'ERROR', error: true, title: 'Read failed' },
    { toolName: 'make_payment', toolStatus: 'FINISHED', title: 'Payment result' },
    {
      toolName: 'attempt_completion',
      toolStatus: 'IN_PROGRESS',
      phase: 'EXECUTE',
      title: 'Running verifier',
    },
  ])('folds internal status/result $title into work', (metadata) => {
    const message = msg(metadata, { message_id: 'internal-status' });
    const groups = groupTrajectoryWork(
      [comm('before-status'), message, comm('after-status')],
      'COMPLETED',
    );
    expect(groups.groupsByLeadId.size).toBe(1);
    expect(groups.foldedIds.has(message.message_id)).toBe(true);
    expect([...groups.groupsByLeadId.values()][0].activities).toHaveLength(3);
  });
  it.each([
    {
      toolName: 'attempt_completion',
      toolStatus: 'FINISHED',
      phase: 'PLAN',
      title: 'Beginning Execute Phase',
    },
    { toolName: 'attempt_completion', toolStatus: 'FINISHED', title: 'Beginning Execute Phase' },
    { toolName: 'send_message_to_user_execute_phase', toolStatus: 'ERROR', error: true },
    { toolName: 'completion_summary', toolStatus: 'FINISHED' },
    {
      toolName: 'spawn_browser_agent',
      toolStatus: 'FINISHED',
      requestUserAuthentication: { requestId: 'auth', taskId: 'task' },
    },
    { toolName: 'call_phone_number', toolStatus: 'IN_PROGRESS' },
  ])('keeps user-facing transition/output/control $toolName outside work', (metadata) => {
    const message = msg(metadata, { message_id: 'user-facing' });
    const groups = groupTrajectoryWork([comm('before-control'), message], 'ACTIVE');
    expect(groups.foldedIds.has(message.message_id)).toBe(false);
  });
  it.each(['IN_PROGRESS', 'FINISHED', 'ERROR'])(
    'keeps %s plans user-facing, outside work',
    (toolStatus) => {
      const thought = msg(
        { toolName: 'thought', toolStatus: 'FINISHED' },
        { message_id: 'thought' },
      );
      const plan = msg({ toolName: 'set_plan', toolStatus }, { message_id: 'plan' });
      const groups = groupTrajectoryWork([thought, plan], 'ACTIVE');
      expect(groups.foldedIds.has('thought')).toBe(true);
      expect(groups.foldedIds.has('plan')).toBe(false);
      expect(groups.groupsByLeadId.get('thought')?.status).not.toBe('running');
    },
  );

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
