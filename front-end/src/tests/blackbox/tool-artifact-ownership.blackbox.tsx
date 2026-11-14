/** Sanitized production shape: empty assistant artifacts refer to a tool call, not a task. */
import { fireEvent, screen, within, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentContext } from '@/features/agent-context';
import { MessageList } from '@/features/terminal-component-group/components/MessageList';
import { groupToolArtifacts } from '@/features/terminal-component-group/components/toolArtifactGroups';
import { MessageListItems } from '@/features/terminal-component-group/components/MessageListItems';
import type { Message } from '@/lib/api';
import * as api from '@/lib/api';
import { msg } from './code-agent-steering.fixtures';
import { makeCtx } from './browser-agent-chip.fixtures';
import { renderWithProviders } from './test-wrapper';

function artifact(id: string, call: string): Message {
  return msg(
    { artifactOnly: true, sourceToolCallId: call },
    {
      message_id: id,
      role: 'ASSISTANT',
      file_pointer: {
        id,
        created_at: '2026-11-14T12:00:00Z',
        storage_path: `sanitized/${id}.txt`,
        original_filename: `${id}.txt`,
        mime_type: 'text/plain',
        size_bytes: 10,
      },
    },
  );
}
function owner(id: string, call: string, code = false): Message {
  return msg(
    {
      toolName: code ? 'spawn_claude_code_agent' : 'spawn_browser_agent',
      toolCallId: call,
      toolStatus: 'FINISHED',
      action_type: 'task_complete',
      task_id: `task-${id}`,
      title: id,
    },
    { message_id: id, text: 'Task complete' },
  );
}
function view(messages: Message[], compressWork = false) {
  return (
    <AgentContext.Provider value={makeCtx(messages)}>
      <MessageListItems
        filteredMessages={messages}
        compressWork={compressWork}
        workStatus="COMPLETED"
        currentAnimatingId={null}
        onAnimationComplete={() => {}}
        selectedAgentId="agent-1"
        exploreStepMap={new Map()}
        waitForCheckMap={new Map()}
        streamingMetricsBySubAgentId={new Map()}
      />
    </AgentContext.Provider>
  );
}
function row(id: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
  expect(element).not.toBeNull();
  return element!;
}

describe('tool artifact ownership', () => {
  it.each([true, false])('folds files under their exact owner with compression=%s', (compress) => {
    const browser = owner('browser', 'browser-call');
    const code = owner('code', 'code-call', true);
    // A decoy task id equals sourceToolCallId; only toolCallId establishes ownership.
    const decoy = owner('decoy', 'unrelated');
    decoy.metadata = { ...decoy.metadata, task_id: 'browser-call' };
    const files = [artifact('screenshot', 'browser-call'), artifact('report', 'code-call')];
    renderWithProviders(view([browser, code, decoy, ...files], compress));
    expect(screen.queryByText('screenshot.txt')).toBeNull();
    expect(screen.queryByText('report.txt')).toBeNull();
    expect(document.querySelector('[data-message-id="screenshot"]')).toBeNull();
    if (compress)
      fireEvent.click(within(screen.getByTestId('trajectory-work-group')).getByRole('button'));
    fireEvent.click(within(row('browser')).getByTestId('browser-agent-chip-header'));
    expect(within(row('browser')).getByText('screenshot.txt')).toBeVisible();
    expect(within(row('browser')).queryByText('report.txt')).toBeNull();
    expect(within(row('decoy')).queryByText(/Files/)).toBeNull();
    fireEvent.click(within(row('code')).getByText('Files (1)'));
    expect(within(row('code')).getByText('report.txt')).toBeVisible();
  });

  it('keeps early artifacts pending and deduplicates retransmission at the terminal owner', () => {
    const file = artifact('early', 'call');
    const v = renderWithProviders(view([file]));
    expect(screen.queryByText('early.txt')).toBeNull();
    expect(document.querySelector('[data-message-id="early"]')).toBeNull();
    fireEvent.click(screen.getByText('Files (1)'));
    expect(screen.getByText('early.txt')).toBeVisible();
    const progress = owner('progress', 'call');
    progress.metadata = {
      ...progress.metadata,
      toolStatus: 'IN_PROGRESS',
      action_type: 'session_starting',
    };
    v.rerender(view([file, progress]));
    fireEvent.click(within(row('progress')).getByText('Files (1)'));
    expect(within(row('progress')).getByText('early.txt')).toBeVisible();
    const end = owner('end', 'call');
    v.rerender(view([file, progress, end, { ...file, message_id: 'retransmission' }]));
    expect(within(row('progress')).queryByText(/Files/)).toBeNull();
    fireEvent.click(within(row('end')).getByTestId('browser-agent-chip-header'));
    expect(screen.getAllByText('early.txt')).toHaveLength(1);
    const late = artifact('late', 'call');
    v.rerender(view([file, progress, end, late]));
    expect(within(row('end')).getByText('early.txt')).toBeVisible();
    expect(within(row('end')).getByText('late.txt')).toBeVisible();
  });

  it('preserves explicit displays, uploads, ordinary attachments and attention boundaries', () => {
    const ordinary = artifact('ordinary', 'unused');
    ordinary.metadata = {};
    const upload = artifact('upload', 'unused');
    upload.role = 'USER';
    upload.metadata = {};
    const display = artifact('display', 'unused');
    display.metadata = { source: 'display', excludeFromModel: true };
    const attention = msg(
      { isUserAttentionMessage: true, toolName: 'send_message_to_user' },
      { message_id: 'attention', text: 'Please answer' },
    );
    const auth = owner('auth', 'auth-call');
    auth.metadata = { ...auth.metadata, requestUserAuthentication: { requestId: 'auth-request' } };
    renderWithProviders(view([ordinary, upload, display, attention, auth], true));
    for (const id of ['ordinary', 'upload', 'display', 'attention', 'auth'])
      expect(row(id)).toBeInTheDocument();
    expect(screen.getByText('ordinary.txt')).toBeVisible();
    expect(screen.getByText('upload.txt')).toBeVisible();
    expect(screen.getByText('display.txt')).toBeVisible();
  });
  it('keeps ownership through the real MessageList filtering and tool-result dedupe', () => {
    const start = owner('start', 'same-call');
    start.metadata = {
      ...start.metadata,
      toolStatus: 'IN_PROGRESS',
      action_type: 'session_starting',
    };
    const end = owner('end', 'same-call');
    const file = artifact('deduped', 'same-call');
    const messages = [start, file, end];
    renderWithProviders(
      <AgentContext.Provider value={makeCtx(messages)}>
        <MessageList showThinkingIndicator={false} />
      </AgentContext.Provider>,
    );
    expect(screen.queryByText('deduped.txt')).toBeNull();
    fireEvent.click(within(screen.getByTestId('trajectory-work-group')).getByRole('button'));
    fireEvent.click(within(row('end')).getByTestId('browser-agent-chip-header'));
    expect(within(row('end')).getByText('deduped.txt')).toBeVisible();
    expect(document.querySelector('[data-message-id="deduped"]')).toBeNull();
  });

  it('preserves pinned and authentication controls even with artifact metadata', () => {
    const pinned = artifact('pinned', 'call');
    pinned.metadata = {
      ...pinned.metadata,
      display: {
        placement: 'pinned',
        kind: 'question',
        question: 'Choose',
        question_id: 'question',
      },
    };
    const auth = artifact('auth-file', 'call');
    auth.metadata = { ...auth.metadata, requestUserAuthentication: { requestId: 'request' } };
    const attention = artifact('attention-file', 'call');
    attention.metadata = { ...attention.metadata, isUserAttentionMessage: true };
    const upload = artifact('typed-upload', 'call');
    upload.role = 'USER';
    const partial = artifact('untyped', 'call');
    partial.metadata = { sourceToolCallId: 'call' };
    const result = groupToolArtifacts([pinned, auth, attention, upload, partial]);
    expect(result.visibleMessages).toEqual([pinned, auth, attention, upload, partial]);
  });
  it('retains code anchors with subAgentId and artifacts from generic tools', () => {
    const code = owner('tagged-code', 'tagged-call', true);
    code.metadata = { ...code.metadata, subAgentId: 'task-tagged-code' };
    const generic = msg(
      {
        toolName: 'read_file',
        toolCallId: 'generic-call',
        toolStatus: 'FINISHED',
        title: 'Read output',
      },
      { message_id: 'generic', text: 'Read complete' },
    );
    renderWithProviders(
      view([
        code,
        generic,
        artifact('tagged', 'tagged-call'),
        artifact('generic-file', 'generic-call'),
      ]),
    );
    fireEvent.click(within(row('tagged-code')).getByText('Files (1)'));
    expect(within(row('tagged-code')).getByText('tagged.txt')).toBeVisible();
    fireEvent.click(within(row('generic')).getByText('Files (1)'));
    expect(within(row('generic')).getByText('generic-file.txt')).toBeVisible();
  });

  it('keeps output files with their background run instead of the newest call reuse', () => {
    const first = owner('run-one', 'reused', true);
    first.timestamp = '2026-11-14T12:00:00Z';
    const second = owner('run-two', 'reused', true);
    second.timestamp = '2026-11-14T13:00:00Z';
    second.metadata = { ...second.metadata, backgroundRun: 2 };
    const early = artifact('first-run', 'reused');
    early.timestamp = '2026-11-14T12:01:00Z';
    early.metadata = { ...early.metadata, backgroundRun: 1 };
    const late = artifact('second-run', 'reused');
    late.timestamp = '2026-11-14T13:01:00Z';
    late.metadata = { ...late.metadata, backgroundRun: 2 };
    renderWithProviders(view([first, early, second, late]));
    fireEvent.click(within(row('run-one')).getByText('Files (1)'));
    expect(within(row('run-one')).getByText('first-run.txt')).toBeVisible();
    expect(within(row('run-one')).queryByText('second-run.txt')).toBeNull();
    fireEvent.click(within(row('run-two')).getByText('Files (1)'));
    expect(within(row('run-two')).getByText('second-run.txt')).toBeVisible();
    const ambiguous = artifact('unknown-run', 'reused');
    const grouped = groupToolArtifacts([first, early, second, late, ambiguous]);
    expect(grouped.visibleMessages).toContain(ambiguous);
    expect([...grouped.byOwner.values()].flat()).not.toContain(ambiguous);
  });
  it('mounts a screenshot only after opening the actual browser result', async () => {
    const signed = vi
      .spyOn(api, 'getAttachmentUrl')
      .mockResolvedValue('https://example.test/screenshot.png');
    const screenshot = artifact('image', 'image-call');
    screenshot.file_pointer = {
      ...screenshot.file_pointer!,
      mime_type: 'image/png',
      original_filename: 'screenshot.png',
    };
    renderWithProviders(view([owner('image-owner', 'image-call'), screenshot]));
    expect(screen.queryByRole('img')).toBeNull();
    expect(signed).not.toHaveBeenCalled();
    fireEvent.click(within(row('image-owner')).getByTestId('browser-agent-chip-header'));
    await waitFor(() =>
      expect(within(row('image-owner')).getByRole('img')).toHaveAttribute(
        'src',
        'https://example.test/screenshot.png',
      ),
    );
    signed.mockRestore();
  });
  it('keeps conflicting tool names sharing a call unresolved rather than guessing', () => {
    const browser = owner('browser-conflict', 'conflict');
    const code = owner('code-conflict', 'conflict', true);
    const file = artifact('conflicting-file', 'conflict');
    const result = groupToolArtifacts([browser, code, file]);
    expect(result.byOwner.size).toBe(0);
    expect(result.visibleMessages).toContain(file);
  });
});
