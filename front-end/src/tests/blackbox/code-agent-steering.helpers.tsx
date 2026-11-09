/**
 * Shared helpers for the code-agent steering blackboxes
 * (code-agent-steering.blackbox.tsx and code-agent-steering-questions.blackbox.tsx):
 * the code-agent view of task-1 as the Terminal opens it, its render and query
 * helpers and the per-test reset. `vi.mock` calls are hoisted per test file and
 * stay in each file.
 */
import { fireEvent, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';

import { CodeAgentConversationView } from '@/features/terminal-component-group/components/code-agent-view/CodeAgentConversationView';
import type { OpenCodeAgent } from '@/features/terminal-component-group/components/code-agent-view/codeAgentViewState';
import { resetCodeAgentLocalState } from '@/features/terminal-component-group/hooks/codeAgentLocalState';
import type { Message } from '@/lib/api';

import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';
import { API_BASE, ROOT_AGENT_ID, WithAgent, signIn } from './code-agent-steering.fixtures';

/** The code-agent view of task-1 as the Terminal opens it (owner = the root chat). */
export const VIEW_AGENT: OpenCodeAgent = {
  taskId: 'task-1',
  ownerAgentId: ROOT_AGENT_ID,
  provider: 'codex',
  title: '3-state speed button',
  status: null,
};

export function viewTree(messages: Message[], readOnlyMessage: string | null = null) {
  return (
    <WithAgent messages={messages}>
      <CodeAgentConversationView codeAgent={VIEW_AGENT} readOnlyMessage={readOnlyMessage} />
    </WithAgent>
  );
}

export function renderView(messages: Message[]) {
  const rendered = renderWithProviders(viewTree(messages));
  return { ...rendered, view: screen.getByTestId('code-agent-view') };
}

/** Expands every collapsed "Worked for …" group in scope; returns its history entries. */
export function expandWork(scope: HTMLElement): HTMLElement[] {
  for (const group of within(scope).queryAllByTestId('trajectory-work-group')) {
    const toggle = within(group).getAllByRole('button')[0];
    if (toggle.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle);
  }
  return within(scope).queryAllByTestId('trajectory-history-entry');
}

/** The view's USER rows (the person's turns, without their sent-time line), in order. */
export function userRows(scope: HTMLElement): string[] {
  return Array.from(scope.querySelectorAll('[data-message-role="USER"]')).map(
    (row) => row.querySelector('[data-testid="user-message-text"]')?.textContent ?? '',
  );
}

/** The view's query box (QueryInput renders in its own layer, outside the view). */
export const viewQueryBox = () => screen.getByPlaceholderText('Message Codex…');

/** Per-test reset shared by the steering files: clean local state, signed in, no live capabilities. */
export function resetSteeringState(fetchSession: { mockClear: () => unknown }) {
  resetCodeAgentLocalState();
  fetchSession.mockClear();
  signIn();
  // A live view reads the session's model catalog; unreachable here (prod 502 shape).
  server.use(
    http.get(`${API_BASE}/claude-code-session/:taskId/capabilities`, () =>
      HttpResponse.json({ error: 'Could not confirm code session capabilities' }, { status: 502 }),
    ),
  );
}
