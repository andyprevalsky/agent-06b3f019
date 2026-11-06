/**
 * Rose left bar ordering (Andy, 2026-11-06): inside every project, folder and
 * Home list, running agents come first, then needs-help, then done; each tier
 * puts the most recent user message on top (creation when never messaged).
 * Sub-agent ordering lives in rose-sidebar-tree.blackbox.tsx.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';

import AppSidebar from '@/features/terminal-component-group/components/AppSidebar';

import { defaultProps, makeAgent, mockSession } from './app-sidebar.fixtures';
import { expandBar, makeProject, mockProjectsApi, signedInUser } from './rose-sidebar.fixtures';
import { renderWithProviders } from './test-wrapper';

const RUNNING = { status: 'ACTIVE' as const, temporal_workflow_id: 'wf-1' };

function rowOrder(): string[] {
  const groups = screen.getByTestId('rose-agent-groups');
  return [
    ...groups.querySelectorAll<HTMLElement>(
      '[data-testid^="rose-agent-row-"], [data-testid^="rose-project-row-"], [data-testid="rose-home-project-row"]',
    ),
  ].map((el) =>
    el.dataset.testid === 'rose-home-project-row'
      ? 'project:home'
      : el.dataset.testid!.replace(/^rose-(agent|project)-row-/, '$1:'),
  );
}

describe('Rose left bar ordering', () => {
  beforeEach(() => {
    localStorage.clear();
    mockSession();
    mockProjectsApi([makeProject()]);
  });

  it('every list puts running agents first, each tier by the most recent user message', async () => {
    const at = (minutes: number) =>
      new Date(Date.parse('2026-10-20T12:00:00Z') - minutes * 60_000).toISOString();
    renderWithProviders(
      <AppSidebar
        {...defaultProps({
          user: signedInUser(),
          agents: [
            makeAgent({
              agent_id: 'done-messaged',
              goal: 'Finished chat',
              status: 'COMPLETED',
              created_at: at(90),
              last_user_message_at: at(1),
            }),
            makeAgent({ agent_id: 'run-new', goal: 'Fresh run', ...RUNNING, created_at: at(10) }),
            makeAgent({
              agent_id: 'help',
              goal: 'Paused run',
              status: 'PAUSED',
              temporal_workflow_id: 'wf-2',
              created_at: at(2),
            }),
            makeAgent({
              agent_id: 'run-messaged',
              goal: 'Old run you just messaged',
              ...RUNNING,
              created_at: at(60),
              last_user_message_at: at(5),
            }),
            makeAgent({
              agent_id: 'done-old',
              goal: 'Old chat',
              status: 'COMPLETED',
              created_at: at(30),
            }),
            makeAgent({
              agent_id: 'rose-done',
              goal: 'Rose done',
              status: 'COMPLETED',
              project_id: 'p-rose',
              created_at: at(1),
            }),
            makeAgent({
              agent_id: 'rose-run',
              goal: 'Rose running',
              ...RUNNING,
              project_id: 'p-rose',
              created_at: at(50),
            }),
          ],
        })}
      />,
    );
    expandBar();
    await screen.findByTestId('rose-project-row-p-rose');
    expect(rowOrder()).toEqual([
      'project:p-rose',
      'agent:rose-run',
      'agent:rose-done',
      'project:home',
      // Running first: the one messaged 5 min ago beats one created 10 min ago.
      'agent:run-messaged',
      'agent:run-new',
      // Then blocked on you, then over (newest user message first).
      'agent:help',
      'agent:done-messaged',
      'agent:done-old',
    ]);
  });
});
